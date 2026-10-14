import type { MiddlewareHandler } from "hono";
import { resolvePricing } from "../commerce/currency";
import { readConfig } from "../env";
import { timingSafeEqual } from "../lib/crypto";
import type { AppEnv } from "../types";

const encoder = new TextEncoder();

function secretMatches(provided: string | undefined, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  return timingSafeEqual(encoder.encode(provided), encoder.encode(expected));
}

/**
 * Resolves config, a request id and the client IP. Forwarded client IPs are
 * trusted only from a gateway that presents GATEWAY_SECRET.
 */
export const requestContext: MiddlewareHandler<AppEnv> = async (c, next) => {
  const config = readConfig(c.env);
  c.set("config", config);
  c.set("requestId", c.req.header("cf-ray") ?? crypto.randomUUID());

  let ip = c.req.header("cf-connecting-ip") ?? "unknown";
  if (secretMatches(c.req.header("x-gateway-secret"), config.gatewaySecret)) {
    const forwarded = c.req.header("x-client-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0];
    if (forwarded && /^[0-9a-fA-F:.]{3,45}$/.test(forwarded.trim())) ip = forwarded.trim();
  }
  c.set("clientIp", ip);
  c.set("userAgent", (c.req.header("user-agent") ?? "").slice(0, 300));
  const pricing = resolvePricing(c);
  c.set("currency", pricing.currency);
  c.set("country", pricing.country);
  await next();
};
