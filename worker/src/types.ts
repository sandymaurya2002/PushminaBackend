import type { Config, Env } from "./env";
import type { AdminRoleKey } from "./auth/permissions";
import type { Currency } from "./commerce/currency";

export interface AuthContext {
  userId: string;
  sessionId: string;
  kind: "CUSTOMER" | "ADMIN";
  email: string;
  name: string;
  adminRole: AdminRoleKey | null;
  permissions: ReadonlySet<string>;
}

export interface AppVariables {
  config: Config;
  requestId: string;
  clientIp: string;
  userAgent: string;
  /** The price list this request is served from (see commerce/currency). */
  currency: Currency;
  /** The shopper's country, when known. */
  country: string | null;
  auth?: AuthContext;
}

export type AppEnv = { Bindings: Env; Variables: AppVariables };
