import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { call, createAdmin, registerCustomer, STRONG_PASSWORD, uniqueEmail } from "./helpers";

describe("customer registration", () => {
  it("creates an account, hashes the password and returns a session", async () => {
    const email = uniqueEmail();
    const result = await call("/api/v1/auth/register", { body: { firstName: "Asha", lastName: "Verma", email, password: STRONG_PASSWORD } });
    expect(result.status).toBe(201);
    expect(result.json.data.user).toMatchObject({ email, firstName: "Asha", lastName: "Verma" });
    expect(result.json.data.tokens.accessToken).toMatch(/^pat_c_/);
    expect(result.json.data.tokens.refreshToken).toMatch(/^prt_c_/);
    expect(result.headers.get("set-cookie")).toMatch(/pushmina_rt=.*HttpOnly; Secure; SameSite=None/);

    const row = await env.DB.prepare(`SELECT password_hash, password_salt, role FROM users WHERE email = ?`).bind(email).first<Record<string, string>>();
    expect(row?.role).toBe("CUSTOMER");
    expect(row?.password_hash).toMatch(/^pbkdf2_sha256\$100000\$/);
    expect(row?.password_hash).not.toContain(STRONG_PASSWORD);

    const session = await env.DB.prepare(`SELECT access_hash FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = ?`).bind(email).first<{ access_hash: string }>();
    expect(session?.access_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(session?.access_hash).not.toBe(result.json.data.tokens.accessToken);
  });

  it("rejects duplicate emails case-insensitively", async () => {
    const { email } = await registerCustomer();
    const result = await call("/api/v1/auth/register", { body: { firstName: "Asha", lastName: "Verma", email: email.toUpperCase(), password: STRONG_PASSWORD } });
    expect(result.status).toBe(409);
    expect(result.json.error?.code).toBe("EMAIL_TAKEN");
  });

  it("validates input", async () => {
    const result = await call("/api/v1/auth/register", { body: { firstName: "A", lastName: "", email: "nope", password: "short" } });
    expect(result.status).toBe(422);
    expect(Object.keys(result.json.error?.details ?? {})).toEqual(expect.arrayContaining(["firstName", "lastName", "email", "password"]));
  });
});

describe("customer login, sessions and logout", () => {
  it("logs in and reads the profile", async () => {
    const { email } = await registerCustomer();
    const login = await call("/api/v1/auth/login", { body: { email, password: STRONG_PASSWORD } });
    expect(login.status).toBe(200);
    const me = await call("/api/v1/auth/me", { token: login.json.data.tokens.accessToken });
    expect(me.status).toBe(200);
    expect(me.json.data.email).toBe(email);
  });

  it("gives the same error for unknown email and wrong password", async () => {
    const { email } = await registerCustomer();
    const wrong = await call("/api/v1/auth/login", { body: { email, password: "Wrong-password-1" } });
    const unknown = await call("/api/v1/auth/login", { body: { email: uniqueEmail(), password: "Wrong-password-1" } });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.json.error?.message).toBe(unknown.json.error?.message);
  });

  it("locks the account after five failures, even with the right password", async () => {
    const { email } = await registerCustomer();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await call("/api/v1/auth/login", { body: { email, password: "Wrong-password-1" } })).status).toBe(401);
    }
    const locked = await call("/api/v1/auth/login", { body: { email, password: STRONG_PASSWORD } });
    expect(locked.status).toBe(429);
    expect(locked.json.error?.code).toBe("ACCOUNT_LOCKED");
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("rotates refresh tokens and revokes the family on reuse", async () => {
    const { refreshToken } = await registerCustomer();
    const first = await call("/api/v1/auth/refresh", { body: { refreshToken } });
    expect(first.status).toBe(200);
    const rotated = first.json.data.tokens.refreshToken;
    expect(rotated).not.toBe(refreshToken);

    // Replaying the old token is treated as theft: it fails and kills the new one too.
    const replay = await call("/api/v1/auth/refresh", { body: { refreshToken } });
    expect(replay.status).toBe(401);
    const afterTheft = await call("/api/v1/auth/refresh", { body: { refreshToken: rotated } });
    expect(afterTheft.status).toBe(401);
    expect((await call("/api/v1/auth/me", { token: first.json.data.tokens.accessToken })).status).toBe(401);
  });

  it("lets only one of two concurrent refreshes win", async () => {
    const { refreshToken } = await registerCustomer();
    const results = await Promise.all([call("/api/v1/auth/refresh", { body: { refreshToken } }), call("/api/v1/auth/refresh", { body: { refreshToken } })]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 401]);
  });

  it("reads the refresh token from the HttpOnly cookie", async () => {
    const { refreshToken } = await registerCustomer();
    const result = await call("/api/v1/auth/refresh", { body: {}, headers: { cookie: `pushmina_rt=${encodeURIComponent(refreshToken)}` } });
    expect(result.status).toBe(200);
  });

  it("logout revokes the refresh token", async () => {
    const { refreshToken } = await registerCustomer();
    const logout = await call("/api/v1/auth/logout", { body: { refreshToken } });
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toMatch(/pushmina_rt=;.*Max-Age=0/);
    expect((await call("/api/v1/auth/refresh", { body: { refreshToken } })).status).toBe(401);
  });

  it("logout-all and change-password end every session", async () => {
    const { email, token } = await registerCustomer();
    const second = await call("/api/v1/auth/login", { body: { email, password: STRONG_PASSWORD } });
    const change = await call("/api/v1/auth/change-password", { token, body: { currentPassword: STRONG_PASSWORD, newPassword: "Another-pass-2026" } });
    expect(change.status).toBe(200);
    expect((await call("/api/v1/auth/me", { token })).status).toBe(401);
    expect((await call("/api/v1/auth/me", { token: second.json.data.tokens.accessToken })).status).toBe(401);
    expect((await call("/api/v1/auth/login", { body: { email, password: "Another-pass-2026" } })).status).toBe(200);
  });

  it("manages addresses with a single default", async () => {
    const { token } = await registerCustomer();
    const address = { fullName: "Asha Verma", phone: "9876543210", line1: "12 Residency Road", city: "Srinagar", state: "Jammu and Kashmir", postalCode: "190001" };
    const first = await call("/api/v1/auth/addresses", { token, body: { ...address, isDefault: true } });
    const second = await call("/api/v1/auth/addresses", { token, body: { ...address, label: "Work", isDefault: true } });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const list = await call("/api/v1/auth/addresses", { token });
    expect(list.json.data.filter((entry: { isDefault: boolean }) => entry.isDefault)).toHaveLength(1);
    const invalid = await call("/api/v1/auth/addresses", { token, body: { ...address, postalCode: "12" } });
    expect(invalid.status).toBe(422);
  });

  it("answers forgot-password the same way whether or not the account exists", async () => {
    const unknown = await call("/api/v1/auth/forgot-password", { body: { email: uniqueEmail() } });
    const known = await call("/api/v1/auth/forgot-password", { body: { email: (await registerCustomer()).email } });
    expect(unknown.status).toBe(200);
    expect(known.status).toBe(200);
    expect(known.json.data).toEqual(unknown.json.data);
  });
});

describe("authorization boundaries", () => {
  it("rejects requests without or with garbage tokens", async () => {
    expect((await call("/api/v1/auth/me")).status).toBe(401);
    expect((await call("/api/v1/cart", { token: "pat_c_garbage" })).status).toBe(401);
    expect((await call("/api/v1/admin/products")).status).toBe(401);
  });

  it("does not accept customer tokens on admin routes or admin tokens on customer routes", async () => {
    const customer = await registerCustomer();
    const admin = await createAdmin("SUPER_ADMIN");
    expect((await call("/api/v1/admin/products", { token: customer.token })).status).toBe(401);
    expect((await call("/api/v1/admin/auth/me", { token: customer.token })).status).toBe(401);
    expect((await call("/api/v1/auth/me", { token: admin.token })).status).toBe(401);
  });

  it("does not let customers sign in to the admin", async () => {
    const { email } = await registerCustomer();
    const result = await call("/api/v1/admin/auth/login", { body: { email, password: STRONG_PASSWORD } });
    expect(result.status).toBe(401);
  });

  it("does not let admins sign in through the storefront", async () => {
    const admin = await createAdmin("ADMIN");
    const result = await call("/api/v1/auth/login", { body: { email: admin.email, password: admin.password } });
    expect(result.status).toBe(401);
  });

  it("enforces role permissions", async () => {
    const support = await createAdmin("SUPPORT");
    const editor = await createAdmin("EDITOR");
    expect((await call("/api/v1/admin/orders", { token: support.token })).status).toBe(200);
    expect((await call("/api/v1/admin/products", { token: support.token, body: { name: "Nope", price: 10 } })).status).toBe(403);
    expect((await call("/api/v1/admin/admins", { token: support.token })).status).toBe(403);
    expect((await call("/api/v1/admin/customers", { token: editor.token })).status).toBe(403);
    expect((await call("/api/v1/admin/media", { token: editor.token })).status).toBe(200);
    const admin = await createAdmin("ADMIN");
    expect((await call("/api/v1/admin/admins", { token: admin.token })).status).toBe(403);
  });

  it("returns the admin profile with permissions", async () => {
    const manager = await createAdmin("MANAGER");
    const me = await call("/api/v1/admin/auth/me", { token: manager.token });
    expect(me.status).toBe(200);
    expect(me.json.data.role.slug).toBe("manager");
    expect(me.json.data.permissions).toContain("orders.update");
    expect(me.json.data.permissions).not.toContain("admins.view");
  });

  it("ends an admin's access as soon as they are deactivated", async () => {
    const owner = await createAdmin("SUPER_ADMIN");
    const staff = await createAdmin("MANAGER");
    expect((await call(`/api/v1/admin/admins/${staff.id}`, { method: "PATCH", token: owner.token, body: { isActive: false } })).status).toBe(200);
    expect((await call("/api/v1/admin/auth/me", { token: staff.token })).status).toBe(401);
    expect((await call("/api/v1/admin/auth/login", { body: { email: staff.email, password: staff.password } })).status).toBe(401);
  });
});
