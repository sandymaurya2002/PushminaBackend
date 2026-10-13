import type { Config, Env } from "./env";
import type { AdminRoleKey } from "./auth/permissions";

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
  auth?: AuthContext;
}

export type AppEnv = { Bindings: Env; Variables: AppVariables };
