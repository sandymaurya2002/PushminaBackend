import { env, SELF } from "cloudflare:test";
import type { AdminRoleKey } from "../src/auth/permissions";
import { hashPassword } from "../src/lib/crypto";
import { newId } from "../src/lib/util";

export const ADMIN_ORIGIN = "https://admin.test";
export const SHOP_ORIGIN = "https://shop.test";
export const GATEWAY_SECRET = "test-gateway-secret";

let counter = 0;

/** A unique client IP per call keeps per-IP rate limits from leaking between tests. */
export function uniqueIp(): string {
  counter += 1;
  return `10.${Math.floor(Math.random() * 200)}.${(counter >> 8) & 255}.${counter & 255}`;
}

export function uniqueEmail(prefix = "user"): string {
  counter += 1;
  return `${prefix}.${Date.now()}.${counter}.${Math.floor(Math.random() * 1e6)}@example.com`;
}

export interface CallOptions {
  method?: string;
  body?: unknown;
  token?: string;
  origin?: string;
  ip?: string;
  headers?: Record<string, string>;
  form?: FormData;
  rawBody?: string;
}

export interface CallResult<T = any> {
  status: number;
  headers: Headers;
  json: { success: boolean; data: T; meta?: Record<string, any>; error?: { code: string; message: string; details?: Record<string, string> } };
  text: string;
}

export async function call<T = any>(path: string, options: CallOptions = {}): Promise<CallResult<T>> {
  const headers = new Headers(options.headers);
  if (!headers.has("x-gateway-secret")) headers.set("x-gateway-secret", GATEWAY_SECRET);
  headers.set("x-client-ip", options.ip ?? uniqueIp());
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.origin) headers.set("origin", options.origin);
  let body: BodyInit | undefined;
  if (options.rawBody !== undefined) body = options.rawBody;
  else if (options.form) body = options.form;
  else if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.body);
  }
  const response = await SELF.fetch(`https://api.test${path}`, { method: options.method ?? (body ? "POST" : "GET"), headers, body });
  const isText = /json|text|csv/.test(response.headers.get("content-type") ?? "text");
  const text = isText ? await response.text() : (await response.arrayBuffer(), "");
  let json: CallResult<T>["json"];
  try {
    json = JSON.parse(text);
  } catch {
    json = { success: false, data: undefined as T };
  }
  return { status: response.status, headers: response.headers, json, text };
}

export const STRONG_PASSWORD = "Pashmina2026!";

export async function registerCustomer(overrides: Record<string, unknown> = {}) {
  const email = uniqueEmail("customer");
  const result = await call("/api/v1/auth/register", {
    body: { firstName: "Asha", lastName: "Verma", email, password: STRONG_PASSWORD, ...overrides },
  });
  if (result.status !== 201) throw new Error(`register failed: ${result.status} ${result.text}`);
  return { email, token: result.json.data.tokens.accessToken as string, refreshToken: result.json.data.tokens.refreshToken as string, user: result.json.data.user };
}

/** Admins are created directly in D1, mirroring the bootstrap script. */
export async function createAdmin(role: AdminRoleKey = "SUPER_ADMIN", password = "Admin-Password-2026") {
  const email = uniqueEmail(role.toLowerCase());
  const { hash, salt } = await hashPassword(password);
  const id = newId();
  await env.DB.prepare(`INSERT INTO users (id, email, name, password_hash, password_salt, role, admin_role, active) VALUES (?, ?, ?, ?, ?, 'ADMIN', ?, 1)`)
    .bind(id, email, `${role} Tester`, hash, salt, role)
    .run();
  const login = await call("/api/v1/admin/auth/login", { body: { email, password } });
  if (login.status !== 200) throw new Error(`admin login failed: ${login.status} ${login.text}`);
  return { id, email, password, token: login.json.data.tokens.accessToken as string, refreshToken: login.json.data.tokens.refreshToken as string };
}

export async function ensureCategory(adminToken: string): Promise<string> {
  const existing = await env.DB.prepare(`SELECT id FROM categories LIMIT 1`).first<{ id: string }>();
  if (existing) return existing.id;
  const result = await call("/api/v1/admin/taxonomy/categories", { token: adminToken, body: { name: "Shawls", slug: `shawls-${Date.now()}` } });
  if (result.status !== 201) throw new Error(`category failed: ${result.status} ${result.text}`);
  return result.json.data.id as string;
}

export async function createProduct(adminToken: string, overrides: Record<string, unknown> = {}) {
  counter += 1;
  const tag = `${Date.now()}-${counter}`;
  const result = await call("/api/v1/admin/products", {
    token: adminToken,
    body: {
      name: `Test Shawl ${tag}`,
      slug: `test-shawl-${tag}`,
      price: 2500,
      status: "PUBLISHED",
      categoryId: await ensureCategory(adminToken),
      images: [{ url: "https://images.example.com/shawl.jpg", alt: "Shawl" }],
      variants: [{ sku: `SKU-${tag}`, inventory: 5 }],
      ...overrides,
    },
  });
  if (result.status !== 201) throw new Error(`product failed: ${result.status} ${result.text}`);
  return result.json.data as { id: string; slug: string; raw: { variants: Array<{ id: string; inventory: number }>; stock: number } };
}

export const ADDRESS = {
  fullName: "Asha Verma",
  email: "asha@example.com",
  phone: "9876543210",
  line1: "12 Residency Road",
  city: "Srinagar",
  state: "Jammu and Kashmir",
  postalCode: "190001",
  country: "India",
};

export async function stockOf(productId: string) {
  return (await env.DB.prepare(`SELECT stock FROM products WHERE id = ?`).bind(productId).first<{ stock: number }>())?.stock;
}

/** Smallest valid PNG header (1x1) followed by padding; enough for the sniffer. */
export function tinyPng(): Uint8Array {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
    0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
    0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
}
