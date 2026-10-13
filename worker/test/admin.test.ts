import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ADDRESS, call, createAdmin, createProduct, registerCustomer, uniqueEmail } from "./helpers";

async function placeOrderFor(adminToken: string) {
  const customer = await registerCustomer();
  const product = await createProduct(adminToken);
  await call("/api/v1/cart/items", { token: customer.token, body: { variantId: product.raw.variants[0]!.id, quantity: 1 } });
  const order = await call("/api/v1/orders", { token: customer.token, body: { address: ADDRESS, paymentMethod: "COD" } });
  if (order.status !== 201) throw new Error(`order failed: ${order.status} ${order.text}`);
  return { customer, product, order: order.json.data };
}

describe("admin orders", () => {
  it("lists, filters, shows detail and exports CSV", async () => {
    const admin = await createAdmin();
    const { order } = await placeOrderFor(admin.token);

    const list = await call(`/api/v1/admin/orders?q=${order.orderNumber}`, { token: admin.token });
    expect(list.status).toBe(200);
    expect(list.json.data).toHaveLength(1);
    expect(list.json.data[0]).toMatchObject({ orderNumber: order.orderNumber, status: "PENDING", paymentMethod: "COD", itemCount: 1 });

    const detail = await call(`/api/v1/admin/orders/${order.id}`, { token: admin.token });
    expect(detail.json.data.allowedTransitions).toEqual(["CONFIRMED", "CANCELLED"]);
    expect(detail.json.data.statusHistory).toHaveLength(1);

    const confirmed = await call(`/api/v1/admin/orders/${order.id}/status`, { method: "PATCH", token: admin.token, body: { status: "CONFIRMED", note: "Called customer" } });
    expect(confirmed.json.data.status).toBe("CONFIRMED");
    expect(confirmed.json.data.statusHistory.at(-1)).toMatchObject({ fromStatus: "PENDING", toStatus: "CONFIRMED", note: "Called customer" });

    const csv = await call("/api/v1/admin/orders/export/csv", { token: admin.token });
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.text).toContain(order.orderNumber);
  });

  it("requires fulfil/cancel permissions for those transitions", async () => {
    const admin = await createAdmin();
    const support = await createAdmin("SUPPORT");
    const { order } = await placeOrderFor(admin.token);
    expect((await call(`/api/v1/admin/orders/${order.id}/status`, { method: "PATCH", token: support.token, body: { status: "CANCELLED" } })).status).toBe(403);
    expect((await call(`/api/v1/admin/orders/${order.id}/status`, { method: "PATCH", token: support.token, body: { status: "CONFIRMED" } })).status).toBe(200);
    expect((await call(`/api/v1/admin/orders/${order.id}/status`, { method: "PATCH", token: support.token, body: { status: "PACKED" } })).status).toBe(403);
  });

  it("has no fake refunds", async () => {
    const admin = await createAdmin();
    expect((await call("/api/v1/admin/payments/refunds", { token: admin.token, body: {} })).status).toBe(501);
  });
});

describe("admin customers", () => {
  it("lists with spend, blocks (ending sessions) and unblocks", async () => {
    const admin = await createAdmin();
    const { customer } = await placeOrderFor(admin.token);
    const list = await call(`/api/v1/admin/customers?q=${encodeURIComponent(customer.email)}`, { token: admin.token });
    expect(list.json.data[0]).toMatchObject({ email: customer.email, status: "ACTIVE", orderCount: 1, lifetimeSpend: 2649 });

    const blocked = await call(`/api/v1/admin/customers/${customer.user.id}/block`, { token: admin.token, body: { blocked: true } });
    expect(blocked.json.data.status).toBe("BLOCKED");
    expect((await call("/api/v1/auth/me", { token: customer.token })).status).toBe(401);
    expect((await call("/api/v1/auth/login", { body: { email: customer.email, password: "Pashmina2026!" } })).status).toBe(401);

    await call(`/api/v1/admin/customers/${customer.user.id}/block`, { token: admin.token, body: { blocked: false } });
    expect((await call("/api/v1/auth/login", { body: { email: customer.email, password: "Pashmina2026!" } })).status).toBe(200);

    const detail = await call(`/api/v1/admin/customers/${customer.user.id}`, { token: admin.token });
    expect(detail.json.data.orders).toHaveLength(1);
    expect(detail.json.data.stats.lifetimeSpend).toBe(2649);
  });

  it("does not list admins as customers", async () => {
    const admin = await createAdmin();
    const list = await call(`/api/v1/admin/customers?q=${encodeURIComponent(admin.email)}`, { token: admin.token });
    expect(list.json.data).toHaveLength(0);
  });

  it("erases personal data on delete but keeps the order", async () => {
    const admin = await createAdmin();
    const { customer, order } = await placeOrderFor(admin.token);
    const removed = await call(`/api/v1/admin/customers/${customer.user.id}`, { method: "DELETE", token: admin.token });
    expect(removed.status).toBe(200);
    const row = await env.DB.prepare(`SELECT email, name, phone, deleted_at FROM users WHERE id = ?`).bind(customer.user.id).first<Record<string, string | null>>();
    expect(row?.email).toMatch(/@deleted\.invalid$/);
    expect(row?.deleted_at).not.toBeNull();
    expect((await call(`/api/v1/admin/orders/${order.id}`, { token: admin.token })).status).toBe(200);
  });
});

describe("admin users and roles", () => {
  it("creates an admin with a strong password and a known role", async () => {
    const owner = await createAdmin("SUPER_ADMIN");
    const email = uniqueEmail("staff");
    const weak = await call("/api/v1/admin/admins", { token: owner.token, body: { name: "Staff", email, password: "short1", roleId: "manager" } });
    expect(weak.status).toBe(422);
    const badRole = await call("/api/v1/admin/admins", { token: owner.token, body: { name: "Staff", email, password: "A-long-password-1", roleId: "god" } });
    expect(badRole.status).toBe(422);
    const created = await call("/api/v1/admin/admins", { token: owner.token, body: { name: "Staff", email, password: "A-long-password-1", roleId: "manager" } });
    expect(created.status).toBe(201);
    expect(created.json.data.role.slug).toBe("manager");
    expect((await call("/api/v1/admin/auth/login", { body: { email, password: "A-long-password-1" } })).status).toBe(200);
  });

  it("refuses to turn a customer account into an admin", async () => {
    const owner = await createAdmin("SUPER_ADMIN");
    const customer = await registerCustomer();
    const result = await call("/api/v1/admin/admins", { token: owner.token, body: { name: "Staff", email: customer.email, password: "A-long-password-1", roleId: "admin" } });
    expect(result.status).toBe(409);
  });

  it("blocks self-demotion and self-removal", async () => {
    const owner = await createAdmin("SUPER_ADMIN");
    expect((await call(`/api/v1/admin/admins/${owner.id}`, { method: "PATCH", token: owner.token, body: { roleId: "admin" } })).status).toBe(400);
    expect((await call(`/api/v1/admin/admins/${owner.id}`, { method: "DELETE", token: owner.token })).status).toBe(400);
  });

  it("keeps one Super Admin when the last two remove each other at once", async () => {
    await env.DB.prepare(`UPDATE users SET active = 0 WHERE role = 'ADMIN' AND admin_role = 'SUPER_ADMIN'`).run();
    const first = await createAdmin("SUPER_ADMIN");
    const second = await createAdmin("SUPER_ADMIN");
    const results = await Promise.all([
      call(`/api/v1/admin/admins/${second.id}`, { method: "DELETE", token: first.token }),
      call(`/api/v1/admin/admins/${first.id}`, { method: "DELETE", token: second.token }),
    ]);
    // The loser either lost its own session first (401) or hit the last-admin guard (409).
    expect(results.filter((result) => result.status === 200)).toHaveLength(1);
    expect([401, 409]).toContain(results.find((result) => result.status !== 200)?.status);
    const remaining = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE admin_role = 'SUPER_ADMIN' AND active = 1 AND deleted_at IS NULL`).first<{ n: number }>();
    expect(remaining?.n).toBe(1);
  });

  it("lists fixed roles and refuses permission edits", async () => {
    const owner = await createAdmin("SUPER_ADMIN");
    const roles = await call("/api/v1/admin/roles", { token: owner.token });
    expect(roles.json.data.roles.map((role: { slug: string }) => role.slug)).toEqual(["super-admin", "admin", "manager", "editor", "support"]);
    expect(roles.json.data.allPermissions.length).toBeGreaterThan(20);
    expect((await call("/api/v1/admin/roles/admin/permissions", { method: "PUT", token: owner.token, body: { permissions: [] } })).status).toBe(501);
  });
});

describe("audit and dashboard", () => {
  it("records admin actions without secrets", async () => {
    const owner = await createAdmin("SUPER_ADMIN");
    const email = uniqueEmail("audited");
    await call("/api/v1/admin/admins", { token: owner.token, body: { name: "Audited", email, password: "A-long-password-1", roleId: "editor" } });
    const audit = await call("/api/v1/admin/audit?entityType=admin&limit=100", { token: owner.token });
    expect(audit.status).toBe(200);
    const entry = audit.json.data.find((row: { action: string; metadata: { email?: string } }) => row.action === "admin.create" && row.metadata.email === email);
    expect(entry).toBeDefined();
    expect(entry.adminUser.id).toBe(owner.id);
    expect(audit.text).not.toContain("A-long-password-1");
  });

  it("summarises the store", async () => {
    const admin = await createAdmin();
    await placeOrderFor(admin.token);
    const dashboard = await call("/api/v1/admin/dashboard?days=7", { token: admin.token });
    expect(dashboard.status).toBe(200);
    expect(dashboard.json.data.chart).toHaveLength(7);
    expect(dashboard.json.data.totals.orders).toBeGreaterThan(0);
    expect(dashboard.json.data.revenue.gross).toBeGreaterThan(0);
    const stats = await call("/api/v1/admin/dashboard/order-stats", { token: admin.token });
    expect(stats.json.data.PENDING).toBeGreaterThan(0);
  });

  it("returns 501 for modules that are not migrated", async () => {
    const admin = await createAdmin();
    for (const path of ["/api/v1/admin/reviews", "/api/v1/admin/coupons", "/api/v1/admin/blog/posts", "/api/v1/admin/content/banners"]) {
      expect((await call(path, { token: admin.token })).status).toBe(501);
    }
  });
});
