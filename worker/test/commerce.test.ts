import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { app } from "../src/index";
import { ADDRESS, call, createAdmin, createProduct, GATEWAY_SECRET, registerCustomer, stockOf, uniqueIp } from "./helpers";
import { installRazorpayMock } from "./razorpay-mock";

async function addToCart(token: string, variantId: string, quantity = 1) {
  const result = await call("/api/v1/cart/items", { token, body: { variantId, quantity } });
  if (result.status !== 200) throw new Error(`cart add failed: ${result.status} ${result.text}`);
  return result;
}

function placeOrder(token: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return call("/api/v1/orders", { token, body: { address: ADDRESS, paymentMethod: "COD", ...extra }, headers });
}

describe("products", () => {
  it("creates, publishes and exposes a public DTO without admin-only fields", async () => {
    const admin = await createAdmin();
    const product = await createProduct(admin.token, { costPrice: 900 });
    expect(product.raw.stock).toBe(5);

    const publicView = await call(`/api/v1/products/${product.slug}`);
    expect(publicView.status).toBe(200);
    expect(publicView.json.data.slug).toBe(product.slug);
    expect(publicView.text).not.toContain("costPrice");
    expect(publicView.text).not.toContain("cost_price");
    expect(publicView.headers.get("cache-control")).toContain("public");

    const list = await call("/api/v1/products?limit=100");
    expect(list.json.data.some((entry: { slug: string }) => entry.slug === product.slug)).toBe(true);
  });

  it("hides drafts from the storefront and refuses to publish without images", async () => {
    const admin = await createAdmin();
    const draft = await createProduct(admin.token, { status: "DRAFT", images: [] });
    expect((await call(`/api/v1/products/${draft.slug}`)).status).toBe(404);

    const publish = await call(`/api/v1/admin/products/${draft.id}`, {
      method: "PUT",
      token: admin.token,
      body: { name: "Draft", slug: draft.slug, price: 100, status: "PUBLISHED", images: [] },
    });
    expect(publish.status).toBe(422);
    expect(publish.json.error?.details?.images).toBeDefined();
  });

  it("rejects duplicate slugs and SKUs", async () => {
    const admin = await createAdmin();
    const product = await createProduct(admin.token);
    const duplicate = await call("/api/v1/admin/products", {
      token: admin.token,
      body: { name: "Copy", slug: product.slug, price: 100, priceUsd: 2, variants: [{ sku: `NEW-${Date.now()}`, inventory: 0 }] },
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.json.error?.code).toBe("SLUG_TAKEN");
  });

  it("archives (rather than deletes) products that have been ordered", async () => {
    const admin = await createAdmin();
    const customer = await registerCustomer();
    const product = await createProduct(admin.token);
    await addToCart(customer.token, product.raw.variants[0]!.id);
    expect((await placeOrder(customer.token)).status).toBe(201);
    const removed = await call(`/api/v1/admin/products/${product.id}`, { method: "DELETE", token: admin.token });
    expect(removed.json.data).toMatchObject({ archived: true, deleted: false });

    const unordered = await createProduct(admin.token);
    const deleted = await call(`/api/v1/admin/products/${unordered.id}`, { method: "DELETE", token: admin.token });
    expect(deleted.json.data).toMatchObject({ archived: false, deleted: true });
  });
});

describe("inventory", () => {
  it("keeps product stock equal to the sum of variant stock", async () => {
    const admin = await createAdmin();
    const product = await createProduct(admin.token, { variants: [{ sku: `A-${Date.now()}`, inventory: 3 }] });
    const variantId = product.raw.variants[0]!.id;
    const adjust = await call(`/api/v1/admin/products/${product.id}/inventory`, { token: admin.token, body: { variantId, delta: 7, reason: "RESTOCK" } });
    expect(adjust.status).toBe(200);
    expect(adjust.json.data.stock).toBe(10);
    expect(await stockOf(product.id)).toBe(10);
    const log = await call(`/api/v1/admin/products/${product.id}/inventory-log`, { token: admin.token });
    expect(log.json.data.map((entry: { reason: string }) => entry.reason)).toEqual(expect.arrayContaining(["RESTOCK", "INITIAL"]));
  });

  it("never lets concurrent adjustments push stock below zero", async () => {
    const admin = await createAdmin();
    const product = await createProduct(admin.token, { variants: [{ sku: `C-${Date.now()}`, inventory: 1 }] });
    const variantId = product.raw.variants[0]!.id;
    const results = await Promise.all(
      Array.from({ length: 4 }, () => call(`/api/v1/admin/products/${product.id}/inventory`, { token: admin.token, body: { variantId, delta: -1, reason: "DAMAGE" } })),
    );
    expect(results.filter((result) => result.status === 200)).toHaveLength(1);
    expect(results.filter((result) => result.status === 409)).toHaveLength(3);
    expect(await stockOf(product.id)).toBe(0);
  });

  it("refuses direct stock writes that would go negative (database guard)", async () => {
    const admin = await createAdmin();
    const product = await createProduct(admin.token);
    await expect(env.DB.prepare(`UPDATE product_variants SET stock = -1 WHERE id = ?`).bind(product.raw.variants[0]!.id).run()).rejects.toThrow();
    await expect(env.DB.prepare(`UPDATE products SET stock = -5 WHERE id = ?`).bind(product.id).run()).rejects.toThrow();
  });

  it("lists stock with low/out filters", async () => {
    const admin = await createAdmin();
    const product = await createProduct(admin.token, { variants: [{ sku: `OUT-${Date.now()}`, inventory: 0 }] });
    const out = await call("/api/v1/admin/inventory?stock=out&limit=100", { token: admin.token });
    expect(out.status).toBe(200);
    expect(out.json.data.some((row: { id: string }) => row.id === product.id)).toBe(true);
  });
});

describe("cart and wishlist", () => {
  it("adds, caps at stock and validates", async () => {
    const admin = await createAdmin();
    const customer = await registerCustomer();
    const product = await createProduct(admin.token, { variants: [{ sku: `CART-${Date.now()}`, inventory: 2 }] });
    const variantId = product.raw.variants[0]!.id;
    const added = await addToCart(customer.token, variantId, 1);
    expect(added.json.data.items[0].quantity).toBe(1);
    expect(added.json.data.totals).toMatchObject({ subtotal: 2500, shipping: 149, total: 2649 });

    const freeShipping = await addToCart(customer.token, variantId, 1);
    expect(freeShipping.json.data.totals).toMatchObject({ subtotal: 5000, shipping: 0, total: 5000 });

    const tooMany = await call("/api/v1/cart/items", { token: customer.token, body: { variantId, quantity: 1 } });
    expect(tooMany.status).toBe(409);
    expect(tooMany.json.error?.code).toBe("INSUFFICIENT_STOCK");
  });

  it("does not sell drafts", async () => {
    const admin = await createAdmin();
    const customer = await registerCustomer();
    const draft = await createProduct(admin.token, { status: "DRAFT", images: [] });
    const result = await call("/api/v1/cart/items", { token: customer.token, body: { variantId: draft.raw.variants[0]!.id, quantity: 1 } });
    expect(result.status).toBe(404);
  });

  it("toggles wishlist items", async () => {
    const admin = await createAdmin();
    const customer = await registerCustomer();
    const product = await createProduct(admin.token);
    const toggled = await call("/api/v1/wishlist/toggle", { token: customer.token, body: { slug: product.slug } });
    expect(toggled.status).toBe(200);
    const slugs = await call("/api/v1/wishlist/slugs", { token: customer.token });
    expect(slugs.json.data).toContain(product.slug);
  });
});

describe("orders", () => {
  it("keeps checkout disabled unless COD or Razorpay is configured", async () => {
    const admin = await createAdmin();
    const customer = await registerCustomer();
    const product = await createProduct(admin.token);
    await addToCart(customer.token, product.raw.variants[0]!.id);
    const response = await app.request(
      "https://api.test/api/v1/orders",
      {
        method: "POST",
        headers: { authorization: `Bearer ${customer.token}`, "content-type": "application/json", "x-gateway-secret": GATEWAY_SECRET, "x-client-ip": uniqueIp() },
        body: JSON.stringify({ address: ADDRESS, paymentMethod: "COD" }),
      },
      { ...env, ENABLE_COD_ORDERS: "false", RAZORPAY_KEY_ID: "", RAZORPAY_KEY_SECRET: "" },
    );
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("CHECKOUT_DISABLED");
    expect(await stockOf(product.id)).toBe(5);
  });

  it("never marks an online order paid at checkout", async () => {
    const admin = await createAdmin();
    const customer = await registerCustomer();
    const product = await createProduct(admin.token);
    await addToCart(customer.token, product.raw.variants[0]!.id);
    const gateway = installRazorpayMock();
    try {
      const result = await placeOrder(customer.token, { paymentMethod: "UPI" });
      expect(result.status).toBe(201);
      expect(result.json.data).toMatchObject({ status: "payment_pending", paymentStatus: "PENDING", paymentMethod: "RAZORPAY", awaitingPayment: true });
      expect(result.json.data.payment.razorpayOrderId).toMatch(/^order_/);
    } finally {
      gateway.restore();
    }
  });

  it("places a COD order, decrements stock, clears the bag and records history", async () => {
    const admin = await createAdmin();
    const customer = await registerCustomer();
    const product = await createProduct(admin.token);
    await addToCart(customer.token, product.raw.variants[0]!.id, 2);
    const result = await placeOrder(customer.token);
    expect(result.status).toBe(201);
    expect(result.json.data.orderNumber).toMatch(/^PSH-\d{6}$/);
    expect(result.json.data.status).toBe("pending");
    expect(result.json.data.paymentStatus).toBe("UNPAID");
    expect(result.json.data.totals.total).toBe(5000 + 0);
    expect(await stockOf(product.id)).toBe(3);
    expect((await call("/api/v1/cart", { token: customer.token })).json.data.items).toHaveLength(0);
    expect(result.json.data.history).toHaveLength(1);
  });

  it("replays an order for the same Idempotency-Key instead of charging twice", async () => {
    const admin = await createAdmin();
    const customer = await registerCustomer();
    const product = await createProduct(admin.token);
    await addToCart(customer.token, product.raw.variants[0]!.id);
    const key = `idem-${Date.now()}`;
    const first = await placeOrder(customer.token, {}, { "idempotency-key": key });
    const second = await placeOrder(customer.token, {}, { "idempotency-key": key });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.json.meta?.replayed).toBe(true);
    expect(second.json.data.id).toBe(first.json.data.id);
    expect(await stockOf(product.id)).toBe(4);
  });

  it("never oversells under concurrent checkouts", async () => {
    const admin = await createAdmin();
    const product = await createProduct(admin.token, { variants: [{ sku: `RACE-${Date.now()}`, inventory: 2 }] });
    const variantId = product.raw.variants[0]!.id;
    const customers = await Promise.all(Array.from({ length: 5 }, () => registerCustomer()));
    for (const customer of customers) await addToCart(customer.token, variantId, 1);

    const results = await Promise.all(customers.map((customer) => placeOrder(customer.token)));
    const statuses = results.map((result) => result.status);
    expect(statuses.filter((status) => status === 201)).toHaveLength(2);
    expect(statuses.filter((status) => status === 409)).toHaveLength(3);
    for (const failed of results.filter((result) => result.status === 409)) {
      expect(["INSUFFICIENT_STOCK", "CART_INVALID"]).toContain(failed.json.error?.code);
    }
    expect(await stockOf(product.id)).toBe(0);
    const variant = await env.DB.prepare(`SELECT stock FROM product_variants WHERE id = ?`).bind(variantId).first<{ stock: number }>();
    expect(variant?.stock).toBe(0);
    const orders = await env.DB.prepare(`SELECT COUNT(*) AS n FROM order_items WHERE variant_id = ?`).bind(variantId).first<{ n: number }>();
    expect(orders?.n).toBe(2);
  });

  it("restocks exactly once when a cancellation races", async () => {
    const admin = await createAdmin();
    const customer = await registerCustomer();
    const product = await createProduct(admin.token);
    await addToCart(customer.token, product.raw.variants[0]!.id, 3);
    const order = await placeOrder(customer.token);
    expect(await stockOf(product.id)).toBe(2);

    const [mine, theirs] = await Promise.all([
      call(`/api/v1/orders/${order.json.data.id}/cancel`, { token: customer.token, body: {} }),
      call(`/api/v1/admin/orders/${order.json.data.id}/status`, { method: "PATCH", token: admin.token, body: { status: "CANCELLED" } }),
    ]);
    expect([mine.status, theirs.status].sort()).toEqual([200, 409]);
    expect(await stockOf(product.id)).toBe(5);

    const again = await call(`/api/v1/orders/${order.json.data.id}/cancel`, { token: customer.token, body: {} });
    expect(again.status).toBe(409);
    expect(await stockOf(product.id)).toBe(5);
  });

  it("does not let customers cancel shipped orders or see other customers' orders", async () => {
    const admin = await createAdmin();
    const customer = await registerCustomer();
    const stranger = await registerCustomer();
    const product = await createProduct(admin.token);
    await addToCart(customer.token, product.raw.variants[0]!.id);
    const order = await placeOrder(customer.token);
    const id = order.json.data.id;
    for (const status of ["PROCESSING", "PACKED", "SHIPPED"]) {
      const step = await call(`/api/v1/admin/orders/${id}/status`, { method: "PATCH", token: admin.token, body: { status, trackingNumber: status === "SHIPPED" ? "TRK123" : undefined } });
      expect(step.status).toBe(200);
    }
    expect((await call(`/api/v1/orders/${id}/cancel`, { token: customer.token, body: {} })).status).toBe(409);
    expect((await call(`/api/v1/orders/${id}`, { token: stranger.token })).status).toBe(404);
    const mine = await call(`/api/v1/orders/${id}`, { token: customer.token });
    expect(mine.json.data.status).toBe("shipped");
    expect(mine.json.data.trackingNumber).toBe("TRK123");
  });

  it("rejects illegal status jumps", async () => {
    const admin = await createAdmin();
    const customer = await registerCustomer();
    const product = await createProduct(admin.token);
    await addToCart(customer.token, product.raw.variants[0]!.id);
    const order = await placeOrder(customer.token);
    const jump = await call(`/api/v1/admin/orders/${order.json.data.id}/status`, { method: "PATCH", token: admin.token, body: { status: "DELIVERED" } });
    expect(jump.status).toBe(409);
    expect(jump.json.error?.code).toBe("INVALID_TRANSITION");
  });

  it("refuses an order when the bag is empty", async () => {
    const customer = await registerCustomer();
    expect((await placeOrder(customer.token)).status).toBe(400);
  });
});
