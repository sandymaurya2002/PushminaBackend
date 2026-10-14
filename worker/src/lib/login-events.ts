import type { Context } from "hono";
import type { AppEnv } from "../types";
import { newId } from "./util";

export type LoginEvent =
  | "REGISTER"
  | "LOGIN"
  | "LOGIN_FAILED"
  | "LOGIN_LOCKED"
  | "LOGOUT"
  | "LOGOUT_ALL"
  | "PASSWORD_CHANGED"
  | "PASSWORD_RESET_REQUESTED"
  | "PASSWORD_RESET";

/**
 * Sign-in activity shown to admins. Holds no secrets: never the password, token or reset link.
 * Without an explicit email the account's current email is stored, so every event is searchable by it.
 */
export function loginEventStatement(
  c: Context<AppEnv>,
  input: { userId: string | null; kind: "CUSTOMER" | "ADMIN"; event: LoginEvent; email?: string | null },
): D1PreparedStatement {
  return c.env.DB.prepare(
    `INSERT INTO login_events (id, user_id, kind, event, email, ip, user_agent)
     VALUES (?1, ?2, ?3, ?4, COALESCE(?5, (SELECT email FROM users WHERE id = ?2)), ?6, ?7)`,
  ).bind(
    newId(),
    input.userId,
    input.kind,
    input.event,
    input.email ?? null,
    c.get("clientIp") ?? null,
    (c.get("userAgent") ?? "").slice(0, 300) || null,
  );
}

export async function recordLoginEvent(c: Context<AppEnv>, input: Parameters<typeof loginEventStatement>[1]): Promise<void> {
  try {
    await loginEventStatement(c, input).run();
  } catch (error) {
    console.error("login event write failed", input.event, error);
  }
}
