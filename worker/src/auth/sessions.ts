import type { Context } from "hono";
import { randomToken, sha256Hex } from "../lib/crypto";
import { unauthorized } from "../lib/errors";
import { newId } from "../lib/util";
import type { AppEnv, AuthContext } from "../types";
import { ADMIN_ROLE_KEYS, permissionsFor, type AdminRoleKey } from "./permissions";

export type SessionKind = "CUSTOMER" | "ADMIN";

export interface IssuedTokens {
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  refreshExpiresAt: number;
}

export const COOKIE = {
  CUSTOMER: { name: "pushmina_rt", path: "/api/v1/auth" },
  ADMIN: { name: "pushmina_art", path: "/api/v1/admin/auth" },
} as const;

function refreshTtl(c: Context<AppEnv>, kind: SessionKind): number {
  const config = c.get("config");
  return kind === "ADMIN" ? config.adminRefreshTtlMs : config.refreshTtlMs;
}

/** Builds the INSERT for a new session; the caller decides whether to batch it. */
export async function prepareSession(
  c: Context<AppEnv>,
  userId: string,
  kind: SessionKind,
  familyId?: string,
): Promise<{ statement: D1PreparedStatement; tokens: IssuedTokens }> {
  const now = Date.now();
  const config = c.get("config");
  const sessionId = newId();
  const accessToken = randomToken(kind === "ADMIN" ? "pat_a" : "pat_c");
  const refreshToken = randomToken(kind === "ADMIN" ? "prt_a" : "prt_c");
  const [accessHash, refreshHash] = await Promise.all([sha256Hex(accessToken), sha256Hex(refreshToken)]);
  const accessExpiresAt = now + config.accessTtlMs;
  const refreshExpiresAt = now + refreshTtl(c, kind);

  const statement = c.env.DB.prepare(
    `INSERT INTO sessions (id, user_id, access_hash, refresh_hash, expires_at, refresh_expires_at, kind, family_id, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(sessionId, userId, accessHash, refreshHash, accessExpiresAt, refreshExpiresAt, kind, familyId ?? sessionId, c.get("clientIp"), c.get("userAgent"));

  return {
    statement,
    tokens: { sessionId, accessToken, refreshToken, expiresIn: Math.floor(config.accessTtlMs / 1000), refreshExpiresAt },
  };
}

interface SessionUserRow {
  session_id: string;
  user_id: string;
  email: string;
  name: string;
  role: string;
  admin_role: string | null;
}

/** Resolves an access token to a live session of the requested kind, or null. */
export async function authenticateAccessToken(db: D1Database, token: string, kind: SessionKind): Promise<AuthContext | null> {
  if (!token || token.length > 200) return null;
  const hash = await sha256Hex(token);
  const row = await db
    .prepare(
      `SELECT s.id AS session_id, u.id AS user_id, u.email, u.name, u.role, u.admin_role
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.access_hash = ? AND s.kind = ? AND s.revoked_at IS NULL AND s.expires_at > ?
          AND u.active = 1 AND u.deleted_at IS NULL`,
    )
    .bind(hash, kind, Date.now())
    .first<SessionUserRow>();
  if (!row) return null;

  let adminRole: AdminRoleKey | null = null;
  if (kind === "ADMIN") {
    if (row.role !== "ADMIN" || !ADMIN_ROLE_KEYS.includes(row.admin_role as AdminRoleKey)) return null;
    adminRole = row.admin_role as AdminRoleKey;
  } else if (row.role !== "CUSTOMER") {
    return null;
  }

  return {
    userId: row.user_id,
    sessionId: row.session_id,
    kind,
    email: row.email,
    name: row.name,
    adminRole,
    permissions: permissionsFor(adminRole),
  };
}

/**
 * Single-use refresh rotation. The old session is claimed with a conditional
 * UPDATE, so two concurrent refreshes with the same token cannot both succeed.
 * Presenting an already-rotated token is treated as theft: the whole session
 * family is revoked.
 */
export async function rotateRefreshToken(
  c: Context<AppEnv>,
  refreshToken: string,
  kind: SessionKind,
): Promise<{ userId: string; tokens: IssuedTokens }> {
  if (!refreshToken || refreshToken.length > 200) throw unauthorized("Your session has expired. Please sign in again.");
  const db = c.env.DB;
  const now = Date.now();
  const hash = await sha256Hex(refreshToken);
  const session = await db
    .prepare(
      `SELECT s.id, s.user_id, s.family_id, s.revoked_at, s.rotated_at, s.refresh_expires_at, u.active, u.deleted_at, u.role, u.admin_role
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.refresh_hash = ? AND s.kind = ?`,
    )
    .bind(hash, kind)
    .first<{
      id: string;
      user_id: string;
      family_id: string | null;
      revoked_at: number | null;
      rotated_at: number | null;
      refresh_expires_at: number;
      active: number;
      deleted_at: string | null;
      role: string;
      admin_role: string | null;
    }>();

  const expired = unauthorized("Your session has expired. Please sign in again.");
  if (!session) throw expired;

  if (session.revoked_at !== null) {
    if (session.rotated_at !== null) {
      await db
        .prepare(`UPDATE sessions SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL`)
        .bind(now, session.family_id ?? session.id)
        .run();
      console.warn("refresh token reuse detected; session family revoked", session.family_id);
    }
    throw expired;
  }
  if (session.refresh_expires_at <= now || session.active !== 1 || session.deleted_at) throw expired;
  if (kind === "ADMIN" && (session.role !== "ADMIN" || !session.admin_role)) throw expired;
  if (kind === "CUSTOMER" && session.role !== "CUSTOMER") throw expired;

  const claim = await db
    .prepare(`UPDATE sessions SET revoked_at = ?, rotated_at = ? WHERE id = ? AND revoked_at IS NULL`)
    .bind(now, now, session.id)
    .run();
  if ((claim.meta.changes ?? 0) === 0) throw expired;

  const { statement, tokens } = await prepareSession(c, session.user_id, kind, session.family_id ?? session.id);
  await statement.run();
  return { userId: session.user_id, tokens };
}

export async function revokeByRefreshToken(db: D1Database, refreshToken: string, kind: SessionKind): Promise<void> {
  if (!refreshToken || refreshToken.length > 200) return;
  await db
    .prepare(`UPDATE sessions SET revoked_at = ? WHERE refresh_hash = ? AND kind = ? AND revoked_at IS NULL`)
    .bind(Date.now(), await sha256Hex(refreshToken), kind)
    .run();
}

export function revokeSessionStatement(db: D1Database, sessionId: string): D1PreparedStatement {
  return db.prepare(`UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).bind(Date.now(), sessionId);
}

export function revokeAllStatement(db: D1Database, userId: string, exceptSessionId?: string): D1PreparedStatement {
  return db
    .prepare(`UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id <> ?`)
    .bind(Date.now(), userId, exceptSessionId ?? "");
}

export function refreshCookie(kind: SessionKind, token: string, maxAgeSeconds: number): string {
  const { name, path } = COOKIE[kind];
  return `${name}=${encodeURIComponent(token)}; Path=${path}; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=None; Partitioned`;
}

export function clearRefreshCookie(kind: SessionKind): string {
  const { name, path } = COOKIE[kind];
  return `${name}=; Path=${path}; Max-Age=0; HttpOnly; Secure; SameSite=None; Partitioned`;
}

export function readCookie(c: Context, name: string): string | undefined {
  const header = c.req.header("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function bearerToken(c: Context): string | undefined {
  const header = c.req.header("authorization");
  const match = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
  return match?.[1];
}
