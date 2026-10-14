import { Hono, type Context } from "hono";
import { z } from "zod";
import { assertNotLocked, clearFailuresStatement, recordFailure } from "../../auth/lockout";
import { ROLES, type AdminRoleKey, ADMIN_ROLE_KEYS } from "../../auth/permissions";
import {
  authenticateAccessToken,
  bearerToken,
  clearRefreshCookie,
  COOKIE,
  prepareSession,
  readCookie,
  refreshCookie,
  revokeAllStatement,
  revokeByRefreshToken,
  revokeSessionStatement,
  rotateRefreshToken,
} from "../../auth/sessions";
import { audit, auditStatement } from "../../lib/audit";
import { burnPasswordCheck, hashPassword, verifyPassword } from "../../lib/crypto";
import { badRequest, unauthorized } from "../../lib/errors";
import { ok } from "../../lib/http";
import { loginEventStatement, recordLoginEvent } from "../../lib/login-events";
import { nowIso } from "../../lib/util";
import { body, email, password } from "../../lib/validation";
import { currentUser, requireAdmin } from "../../middleware/auth";
import { rateLimit } from "../../middleware/rate-limit";
import type { AppEnv } from "../../types";
import { publicTokens } from "../auth";

export function adminProfile(user: { id: string; email: string; name: string; admin_role: string | null }) {
  const role = ROLES[user.admin_role as AdminRoleKey];
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: null,
    role: { id: role.slug, name: role.name, slug: role.slug },
    permissions: role.permissions,
  };
}

function withRefreshCookie(c: Context<AppEnv>, token: string) {
  c.header("Set-Cookie", refreshCookie("ADMIN", token, Math.floor(c.get("config").adminRefreshTtlMs / 1000)), { append: true });
}

const refreshSchema = z.object({ refreshToken: z.string().min(16).max(200).optional() });

export const adminAuthRoutes = new Hono<AppEnv>();

adminAuthRoutes.post("/login", rateLimit({ name: "admin-login", limit: 10, windowSeconds: 300 }), async (c) => {
  const input = await body(c, z.object({ email, password: z.string().min(1, "Please enter your password.").max(128) }));
  const db = c.env.DB;
  const lockKey = `admin:${input.email}`;
  await assertNotLocked(db, lockKey);

  const user = await db
    .prepare(`SELECT id, email, name, role, admin_role, active, deleted_at, password_hash, password_salt FROM users WHERE email = ?`)
    .bind(input.email)
    .first<{ id: string; email: string; name: string; role: string; admin_role: string | null; active: number; deleted_at: string | null; password_hash: string; password_salt: string }>();

  const valid = user ? await verifyPassword(input.password, user.password_hash, user.password_salt) : (await burnPasswordCheck(input.password), false);
  const isAdmin = user?.role === "ADMIN" && ADMIN_ROLE_KEYS.includes(user.admin_role as AdminRoleKey);
  if (!user || !valid || !isAdmin || user.active !== 1 || user.deleted_at) {
    await recordFailure(db, lockKey);
    await audit(c, { action: "admin.login_failed", entityType: "user", targetId: user?.id ?? null, userId: null, metadata: { email: input.email } });
    await recordLoginEvent(c, { userId: isAdmin ? user!.id : null, kind: "ADMIN", event: "LOGIN_FAILED", email: input.email });
    throw unauthorized("Incorrect email or password.");
  }

  const { statement, tokens } = await prepareSession(c, user.id, "ADMIN");
  await db.batch([
    statement,
    clearFailuresStatement(db, lockKey),
    db.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`).bind(nowIso(), user.id),
    auditStatement(c, { action: "admin.login", entityType: "user", targetId: user.id, userId: user.id }),
    loginEventStatement(c, { userId: user.id, kind: "ADMIN", event: "LOGIN", email: user.email }),
  ]);
  withRefreshCookie(c, tokens.refreshToken);
  return ok(c, { admin: adminProfile(user), tokens: publicTokens(tokens) });
});

adminAuthRoutes.post("/refresh", rateLimit({ name: "admin-refresh", limit: 30, windowSeconds: 60 }), async (c) => {
  const input = await body(c, refreshSchema);
  const token = input.refreshToken ?? readCookie(c, COOKIE.ADMIN.name);
  if (!token) throw unauthorized("No session to refresh.");
  try {
    const { tokens } = await rotateRefreshToken(c, token, "ADMIN");
    withRefreshCookie(c, tokens.refreshToken);
    return ok(c, { tokens: publicTokens(tokens) });
  } catch (error) {
    c.header("Set-Cookie", clearRefreshCookie("ADMIN"), { append: true });
    throw error;
  }
});

adminAuthRoutes.post("/logout", async (c) => {
  const input = await body(c, refreshSchema).catch(() => ({}) as { refreshToken?: string });
  const token = input.refreshToken ?? readCookie(c, COOKIE.ADMIN.name);
  let userId = token ? await revokeByRefreshToken(c.env.DB, token, "ADMIN") : null;
  const bearer = bearerToken(c);
  if (bearer) {
    const auth = await authenticateAccessToken(c.env.DB, bearer, "ADMIN");
    if (auth) {
      await revokeSessionStatement(c.env.DB, auth.sessionId).run();
      userId ??= auth.userId;
    }
  }
  if (userId) await recordLoginEvent(c, { userId, kind: "ADMIN", event: "LOGOUT" });
  c.header("Set-Cookie", clearRefreshCookie("ADMIN"), { append: true });
  return ok(c, { message: "Signed out." });
});

adminAuthRoutes.get("/me", requireAdmin, async (c) => {
  const auth = currentUser(c);
  return ok(c, adminProfile({ id: auth.userId, email: auth.email, name: auth.name, admin_role: auth.adminRole }));
});

adminAuthRoutes.post("/change-password", requireAdmin, rateLimit({ name: "admin-change-password", limit: 5, windowSeconds: 600 }), async (c) => {
  const auth = currentUser(c);
  const input = await body(c, z.object({ currentPassword: z.string().min(1).max(128), newPassword: password.min(12, "Admin passwords need at least 12 characters.") }));
  const db = c.env.DB;
  const row = await db.prepare(`SELECT password_hash, password_salt FROM users WHERE id = ?`).bind(auth.userId).first<{ password_hash: string; password_salt: string }>();
  if (!row || !(await verifyPassword(input.currentPassword, row.password_hash, row.password_salt))) {
    throw badRequest("Your current password is incorrect.", { currentPassword: "Your current password is incorrect." });
  }
  const { hash, salt } = await hashPassword(input.newPassword);
  await db.batch([
    db.prepare(`UPDATE users SET password_hash = ?, password_salt = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(hash, salt, auth.userId),
    revokeAllStatement(db, auth.userId),
    revokeSessionStatement(db, auth.sessionId),
    auditStatement(c, { action: "admin.change_password", entityType: "user", targetId: auth.userId }),
    loginEventStatement(c, { userId: auth.userId, kind: "ADMIN", event: "PASSWORD_CHANGED", email: auth.email }),
  ]);
  c.header("Set-Cookie", clearRefreshCookie("ADMIN"), { append: true });
  return ok(c, { message: "Password changed. Please sign in again." });
});
