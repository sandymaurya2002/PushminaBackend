import type { Context } from "hono";
import type { AppEnv } from "../types";
import { newId } from "./util";

export interface AuditInput {
  action: string;
  entityType?: string;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  userId?: string | null;
}

const SECRET_KEYS = /pass(word)?|token|secret|hash|salt/i;

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => scrub(entry, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, SECRET_KEYS.test(key) ? "[redacted]" : scrub(entry, depth + 1)]),
    );
  }
  if (typeof value === "string" && value.length > 500) return `${value.slice(0, 500)}…`;
  return value;
}

export function auditStatement(c: Context<AppEnv>, input: AuditInput): D1PreparedStatement {
  const auth = c.get("auth");
  return c.env.DB.prepare(
    `INSERT INTO audit_events (id, user_id, action, entity_type, target_id, metadata_json, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    newId(),
    input.userId === undefined ? auth?.userId ?? null : input.userId,
    input.action,
    input.entityType ?? null,
    input.targetId ?? null,
    JSON.stringify(scrub(input.metadata ?? {})),
    c.get("clientIp") ?? null,
    c.get("userAgent") ?? null,
  );
}

/** Audit logging must never break the request it describes. */
export async function audit(c: Context<AppEnv>, input: AuditInput): Promise<void> {
  try {
    await auditStatement(c, input).run();
  } catch (error) {
    console.error("audit write failed", input.action, error);
  }
}
