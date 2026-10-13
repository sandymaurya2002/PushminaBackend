import type { Context, MiddlewareHandler } from "hono";
import { authenticateAccessToken, bearerToken } from "../auth/sessions";
import { hasPermission } from "../auth/permissions";
import { forbidden, unauthorized } from "../lib/errors";
import type { AppEnv, AuthContext } from "../types";

export const requireCustomer: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = bearerToken(c);
  const auth = token ? await authenticateAccessToken(c.env.DB, token, "CUSTOMER") : null;
  if (!auth) throw unauthorized();
  c.set("auth", auth);
  await next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = bearerToken(c);
  const auth = token ? await authenticateAccessToken(c.env.DB, token, "ADMIN") : null;
  if (!auth) throw unauthorized();
  c.set("auth", auth);
  await next();
};

/** Must run after requireAdmin. Super Admin passes every check. */
export function can(...permissions: string[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = c.get("auth");
    if (!auth || auth.kind !== "ADMIN") throw unauthorized();
    if (!permissions.every((permission) => hasPermission(auth.adminRole, permission))) throw forbidden();
    await next();
  };
}

export function currentUser(c: Context<AppEnv>): AuthContext {
  const auth = c.get("auth");
  if (!auth) throw unauthorized();
  return auth;
}
