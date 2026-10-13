import { tooManyRequests } from "../lib/errors";

export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;

export async function assertNotLocked(db: D1Database, key: string): Promise<void> {
  const row = await db.prepare(`SELECT locked_until FROM login_attempts WHERE login_key = ?`).bind(key).first<{ locked_until: number }>();
  const now = Date.now();
  if (row && row.locked_until > now) {
    const retryAfter = Math.ceil((row.locked_until - now) / 1000);
    throw tooManyRequests(retryAfter, "ACCOUNT_LOCKED", "Too many failed sign-in attempts. Please try again later.");
  }
}

/** Counts a failure atomically; the fifth failure inside the window locks the key. */
export async function recordFailure(db: D1Database, key: string): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO login_attempts (login_key, attempts, locked_until, updated_at) VALUES (?1, 1, 0, ?2)
       ON CONFLICT(login_key) DO UPDATE SET
         attempts = CASE WHEN login_attempts.attempts + 1 >= ?3 THEN 0 ELSE login_attempts.attempts + 1 END,
         locked_until = CASE WHEN login_attempts.attempts + 1 >= ?3 THEN ?4 ELSE login_attempts.locked_until END,
         updated_at = ?2`,
    )
    .bind(key, now, MAX_FAILED_LOGINS, now + LOCKOUT_MS)
    .run();
}

export function clearFailuresStatement(db: D1Database, key: string): D1PreparedStatement {
  return db.prepare(`DELETE FROM login_attempts WHERE login_key = ?`).bind(key);
}
