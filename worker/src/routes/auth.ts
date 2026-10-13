import { Hono, type Context } from "hono";
import { z } from "zod";
import { assertNotLocked, clearFailuresStatement, recordFailure } from "../auth/lockout";
import {
  clearRefreshCookie,
  COOKIE,
  prepareSession,
  readCookie,
  refreshCookie,
  revokeAllStatement,
  revokeByRefreshToken,
  revokeSessionStatement,
  rotateRefreshToken,
} from "../auth/sessions";
import { auditStatement } from "../lib/audit";
import { burnPasswordCheck, hashPassword, verifyPassword } from "../lib/crypto";
import { badRequest, conflict, isUniqueViolation, notFound, notImplemented, unauthorized } from "../lib/errors";
import { created, noContent, ok } from "../lib/http";
import { newId, nowIso, toIso } from "../lib/util";
import { addressInput, body, email, password, phone } from "../lib/validation";
import { currentUser, requireCustomer } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";
import type { AppEnv } from "../types";

const registerSchema = z.object({
  firstName: z.string().trim().min(2, "Please enter your first name.").max(60),
  lastName: z.string().trim().min(1, "Please enter your last name.").max(60),
  email,
  password,
  phone: phone.optional(),
  acceptsMarketing: z.boolean().default(false),
});

const loginSchema = z.object({ email, password: z.string().min(1, "Please enter your password.").max(128) });
const refreshSchema = z.object({ refreshToken: z.string().min(16).max(200).optional() });
const profileSchema = z.object({
  firstName: z.string().trim().min(2).max(60).optional(),
  lastName: z.string().trim().min(1).max(60).optional(),
  phone: phone.nullable().optional(),
  acceptsMarketing: z.boolean().optional(),
});
const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: password });

interface UserRow {
  id: string;
  email: string;
  name: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  accepts_marketing: number;
  created_at: string;
}

export function customerDto(row: UserRow) {
  const [first = "", ...rest] = row.name.split(" ");
  return {
    id: row.id,
    email: row.email,
    firstName: row.first_name ?? first,
    lastName: row.last_name ?? rest.join(" "),
    name: row.name,
    phone: row.phone,
    acceptsMarketing: row.accepts_marketing === 1,
    createdAt: toIso(row.created_at),
  };
}

const USER_COLUMNS = "id, email, name, first_name, last_name, phone, accepts_marketing, created_at";

function withRefreshCookie(c: Context<AppEnv>, token: string) {
  c.header("Set-Cookie", refreshCookie("CUSTOMER", token, Math.floor(c.get("config").refreshTtlMs / 1000)), { append: true });
}

export const authRoutes = new Hono<AppEnv>();

const authLimit = rateLimit({ name: "auth", limit: 20, windowSeconds: 60 });

authRoutes.post("/register", rateLimit({ name: "register", limit: 5, windowSeconds: 600 }), async (c) => {
  const input = await body(c, registerSchema);
  const { hash, salt } = await hashPassword(input.password);
  const id = newId();
  const db = c.env.DB;
  const { statement, tokens } = await prepareSession(c, id, "CUSTOMER");
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO users (id, email, name, first_name, last_name, password_hash, password_salt, role, phone, accepts_marketing, last_login_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'CUSTOMER', ?, ?, ?)`,
        )
        .bind(id, input.email, `${input.firstName} ${input.lastName}`, input.firstName, input.lastName, hash, salt, input.phone ?? null, input.acceptsMarketing ? 1 : 0, nowIso()),
      statement,
      auditStatement(c, { action: "customer.register", entityType: "user", targetId: id, userId: id }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict("EMAIL_TAKEN", "An account with this email already exists.", { email: "An account with this email already exists." });
    }
    throw error;
  }
  const user = await db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).bind(id).first<UserRow>();
  withRefreshCookie(c, tokens.refreshToken);
  return created(c, { user: customerDto(user!), tokens: publicTokens(tokens) });
});

authRoutes.post("/login", authLimit, async (c) => {
  const input = await body(c, loginSchema);
  const db = c.env.DB;
  const lockKey = `customer:${input.email}`;
  await assertNotLocked(db, lockKey);

  const user = await db
    .prepare(`SELECT ${USER_COLUMNS}, password_hash, password_salt, role, active, deleted_at FROM users WHERE email = ?`)
    .bind(input.email)
    .first<UserRow & { password_hash: string; password_salt: string; role: string; active: number; deleted_at: string | null }>();

  const valid = user ? await verifyPassword(input.password, user.password_hash, user.password_salt) : (await burnPasswordCheck(input.password), false);
  if (!user || !valid || user.role !== "CUSTOMER" || user.active !== 1 || user.deleted_at) {
    await recordFailure(db, lockKey);
    throw unauthorized("Incorrect email or password.");
  }

  const { statement, tokens } = await prepareSession(c, user.id, "CUSTOMER");
  await db.batch([
    statement,
    clearFailuresStatement(db, lockKey),
    db.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`).bind(nowIso(), user.id),
  ]);
  withRefreshCookie(c, tokens.refreshToken);
  return ok(c, { user: customerDto(user), tokens: publicTokens(tokens) });
});

authRoutes.post("/refresh", authLimit, async (c) => {
  const input = await body(c, refreshSchema);
  const token = input.refreshToken ?? readCookie(c, COOKIE.CUSTOMER.name);
  if (!token) throw unauthorized("No session to refresh.");
  try {
    const { tokens } = await rotateRefreshToken(c, token, "CUSTOMER");
    withRefreshCookie(c, tokens.refreshToken);
    return ok(c, { tokens: publicTokens(tokens) });
  } catch (error) {
    c.header("Set-Cookie", clearRefreshCookie("CUSTOMER"), { append: true });
    throw error;
  }
});

authRoutes.post("/logout", async (c) => {
  const input = await body(c, refreshSchema).catch(() => ({}) as { refreshToken?: string });
  const token = input.refreshToken ?? readCookie(c, COOKIE.CUSTOMER.name);
  if (token) await revokeByRefreshToken(c.env.DB, token, "CUSTOMER");
  c.header("Set-Cookie", clearRefreshCookie("CUSTOMER"), { append: true });
  return ok(c, { message: "Signed out." });
});

authRoutes.post("/forgot-password", authLimit, () => {
  throw notImplemented("Password reset by email is not available yet. Please contact support.");
});
authRoutes.post("/reset-password", authLimit, () => {
  throw notImplemented("Password reset by email is not available yet. Please contact support.");
});

/* Authenticated ------------------------------------------------------ */

authRoutes.use("/me", requireCustomer);
authRoutes.use("/me/*", requireCustomer);
authRoutes.use("/logout-all", requireCustomer);
authRoutes.use("/change-password", requireCustomer);
authRoutes.use("/addresses", requireCustomer);
authRoutes.use("/addresses/*", requireCustomer);

authRoutes.get("/me", async (c) => {
  const auth = currentUser(c);
  const db = c.env.DB;
  const [user, counts] = await db.batch([
    db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).bind(auth.userId),
    db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM orders WHERE user_id = ?1) AS orders, (SELECT COUNT(*) FROM wishlist_items WHERE user_id = ?1) AS wishlist`,
      )
      .bind(auth.userId),
  ]);
  const row = user?.results[0] as UserRow | undefined;
  if (!row) throw notFound("Account");
  const totals = counts?.results[0] as { orders: number; wishlist: number };
  return ok(c, { ...customerDto(row), _count: { orders: totals.orders, wishlistItems: totals.wishlist } });
});

authRoutes.patch("/me", async (c) => {
  const auth = currentUser(c);
  const input = await body(c, profileSchema);
  const db = c.env.DB;
  const current = await db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).bind(auth.userId).first<UserRow>();
  if (!current) throw notFound("Account");
  const dto = customerDto(current);
  const firstName = input.firstName ?? dto.firstName;
  const lastName = input.lastName ?? dto.lastName;
  await db
    .prepare(
      `UPDATE users SET first_name = ?, last_name = ?, name = ?, phone = ?, accepts_marketing = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    )
    .bind(
      firstName,
      lastName,
      `${firstName} ${lastName}`.trim(),
      input.phone === undefined ? current.phone : input.phone,
      input.acceptsMarketing === undefined ? current.accepts_marketing : input.acceptsMarketing ? 1 : 0,
      auth.userId,
    )
    .run();
  const updated = await db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).bind(auth.userId).first<UserRow>();
  return ok(c, customerDto(updated!));
});

authRoutes.post("/logout-all", async (c) => {
  const auth = currentUser(c);
  await c.env.DB.batch([
    revokeAllStatement(c.env.DB, auth.userId),
    revokeSessionStatement(c.env.DB, auth.sessionId),
    auditStatement(c, { action: "customer.logout_all", entityType: "user", targetId: auth.userId }),
  ]);
  c.header("Set-Cookie", clearRefreshCookie("CUSTOMER"), { append: true });
  return ok(c, { message: "Signed out on every device." });
});

authRoutes.post("/change-password", rateLimit({ name: "change-password", limit: 5, windowSeconds: 600 }), async (c) => {
  const auth = currentUser(c);
  const input = await body(c, changePasswordSchema);
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
    auditStatement(c, { action: "customer.change_password", entityType: "user", targetId: auth.userId }),
  ]);
  c.header("Set-Cookie", clearRefreshCookie("CUSTOMER"), { append: true });
  return ok(c, { message: "Password changed. Please sign in again." });
});

/* Addresses ---------------------------------------------------------- */

interface AddressRow {
  id: string;
  label: string;
  full_name: string;
  phone: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postal_code: string;
  country: string;
  is_default: number;
  created_at: string;
}

export function addressDto(row: AddressRow) {
  return {
    id: row.id,
    label: row.label,
    fullName: row.full_name,
    phone: row.phone,
    line1: row.line1,
    line2: row.line2,
    city: row.city,
    state: row.state,
    postalCode: row.postal_code,
    country: row.country,
    isDefault: row.is_default === 1,
    createdAt: toIso(row.created_at),
  };
}

const MAX_ADDRESSES = 20;

async function findAddress(db: D1Database, userId: string, id: string): Promise<AddressRow> {
  const row = await db.prepare(`SELECT * FROM addresses WHERE id = ? AND user_id = ?`).bind(id, userId).first<AddressRow>();
  if (!row) throw notFound("Address");
  return row;
}

authRoutes.get("/addresses", async (c) => {
  const auth = currentUser(c);
  const { results } = await c.env.DB.prepare(`SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, created_at DESC`).bind(auth.userId).all<AddressRow>();
  return ok(c, results.map(addressDto));
});

authRoutes.post("/addresses", rateLimit({ name: "address-write", limit: 30, windowSeconds: 600 }), async (c) => {
  const auth = currentUser(c);
  const input = await body(c, addressInput);
  const db = c.env.DB;
  const count = (await db.prepare(`SELECT COUNT(*) AS n FROM addresses WHERE user_id = ?`).bind(auth.userId).first<{ n: number }>())?.n ?? 0;
  if (count >= MAX_ADDRESSES) throw badRequest(`You can save up to ${MAX_ADDRESSES} addresses.`);
  const id = newId();
  const isDefault = input.isDefault || count === 0;
  await db.batch([
    ...(isDefault ? [db.prepare(`UPDATE addresses SET is_default = 0 WHERE user_id = ?`).bind(auth.userId)] : []),
    db
      .prepare(
        `INSERT INTO addresses (id, user_id, label, full_name, phone, line1, line2, city, state, postal_code, country, is_default)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, auth.userId, input.label, input.fullName, input.phone, input.line1, input.line2 ?? null, input.city, input.state, input.postalCode, input.country, isDefault ? 1 : 0),
  ]);
  return created(c, addressDto(await findAddress(db, auth.userId, id)));
});

authRoutes.patch("/addresses/:id", async (c) => {
  const auth = currentUser(c);
  const db = c.env.DB;
  const existing = await findAddress(db, auth.userId, c.req.param("id"));
  const input = await body(c, addressInput.partial());
  const merged = {
    label: input.label ?? existing.label,
    fullName: input.fullName ?? existing.full_name,
    phone: input.phone ?? existing.phone,
    line1: input.line1 ?? existing.line1,
    line2: input.line2 === undefined ? existing.line2 : input.line2,
    city: input.city ?? existing.city,
    state: input.state ?? existing.state,
    postalCode: input.postalCode ?? existing.postal_code,
    country: input.country ?? existing.country,
  };
  await db.batch([
    ...(input.isDefault ? [db.prepare(`UPDATE addresses SET is_default = 0 WHERE user_id = ?`).bind(auth.userId)] : []),
    db
      .prepare(
        `UPDATE addresses SET label = ?, full_name = ?, phone = ?, line1 = ?, line2 = ?, city = ?, state = ?, postal_code = ?, country = ?,
                is_default = CASE WHEN ? THEN 1 ELSE is_default END
          WHERE id = ? AND user_id = ?`,
      )
      .bind(merged.label, merged.fullName, merged.phone, merged.line1, merged.line2, merged.city, merged.state, merged.postalCode, merged.country, input.isDefault ? 1 : 0, existing.id, auth.userId),
  ]);
  return ok(c, addressDto(await findAddress(db, auth.userId, existing.id)));
});

authRoutes.delete("/addresses/:id", async (c) => {
  const auth = currentUser(c);
  const db = c.env.DB;
  const existing = await findAddress(db, auth.userId, c.req.param("id"));
  await db.batch([
    db.prepare(`DELETE FROM addresses WHERE id = ? AND user_id = ?`).bind(existing.id, auth.userId),
    // Never leave an account with addresses but no default.
    db
      .prepare(
        `UPDATE addresses SET is_default = 1
          WHERE id = (SELECT id FROM addresses WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 1)
            AND NOT EXISTS (SELECT 1 FROM addresses WHERE user_id = ?1 AND is_default = 1)`,
      )
      .bind(auth.userId),
  ]);
  return noContent(c);
});

authRoutes.post("/addresses/:id/default", async (c) => {
  const auth = currentUser(c);
  const db = c.env.DB;
  const existing = await findAddress(db, auth.userId, c.req.param("id"));
  await db.batch([
    db.prepare(`UPDATE addresses SET is_default = 0 WHERE user_id = ?`).bind(auth.userId),
    db.prepare(`UPDATE addresses SET is_default = 1 WHERE id = ? AND user_id = ?`).bind(existing.id, auth.userId),
  ]);
  return ok(c, { message: "Default address updated." });
});

export function publicTokens(tokens: { accessToken: string; refreshToken: string; expiresIn: number }) {
  return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresIn: tokens.expiresIn };
}
