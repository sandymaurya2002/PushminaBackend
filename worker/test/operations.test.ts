import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, expirePayments } from "../src/index";
import { sha256Hex } from "../src/lib/crypto";
import { newId } from "../src/lib/util";
import { ADDRESS, call, createAdmin, createProduct, registerCustomer, STRONG_PASSWORD, stockOf } from "./helpers";
import { installRazorpayMock, webhookRequest, type RazorpayMock } from "./razorpay-mock";

let gateway: RazorpayMock;
beforeEach(() => {
  gateway = installRazorpayMock();
});
afterEach(() => gateway.restore());

async function shopper(quantity = 1, productOverrides: Record<string, unknown> = {}) {
  const admin = await createAdmin();
  const customer = await registerCustomer();
  const product = await createProduct(admin.token, productOverrides);
  const variantId = product.raw.variants[0]!.id;
  const added = await call("/api/v1/cart/items", { token: customer.token, body: { variantId, quantity } });
  if (added.status !== 200 && added.status !== 201) throw new Error(`add to cart failed: ${added.status} ${added.text}`);
  return { admin, customer, product, variantId };
}

async function placeOnline(token: string, extra: Record<string, unknown> = {}) {
  const result = await call("/api/v1/orders", { token, body: { address: ADDRESS, paymentMethod: "RAZORPAY", ...extra } });
  if (result.status !== 201) throw new Error(`order failed: ${result.status} ${result.text}`);
  return result.json.data as { id: string; orderNumber: string; status: string; paymentStatus: string; totals: { total: number }; payment: { razorpayOrderId: string; keyId: string; amount: number } };
}

async function adminStatus(token: string, orderId: string, status: string, extra: Record<string, unknown> = {}) {
  return call(`/api/v1/admin/orders/${orderId}/status`, { method: "PATCH", token, body: { status, ...extra } });
}

async function webhook(event: string, entities: Parameters<typeof webhookRequest>[1], eventId?: string) {
  const request = await webhookRequest(event, entities, eventId);
  return call("/api/v1/payments/razorpay/webhook", { rawBody: request.rawBody, headers: request.headers });
}

describe("Razorpay checkout", () => {
  it("creates a gateway order, holds stock, and only marks the order paid after the server verifies it", async () => {
    const { customer, product } = await shopper();
    const order = await placeOnline(customer.token);
    expect(order.status).toBe("payment_pending");
    expect(order.paymentStatus).toBe("PENDING");
    expect(order.payment.keyId).toBe("rzp_test_mockkey");
    expect(order.payment.amount).toBe(Math.round(order.totals.total * 100));    expect(gateway.orders.get(order.payment.razorpayOrderId)?.amount).toBe(order.payment.amount);
    expect(await stockOf(product.id)).toBe(4);

    // A forged signature is rejected and nothing changes.
    const { verify } = await gateway.pay(order.payment.razorpayOrderId);
    const forged = await call(`/api/v1/orders/${order.id}/payment/verify`, { token: customer.token, body: { ...verify, razorpaySignature: "0".repeat(64) } });
    expect(forged.status).toBe(409);
    expect((await call(`/api/v1/orders/${order.id}`, { token: customer.token })).json.data.status).toBe("payment_pending");

    const verified = await call(`/api/v1/orders/${order.id}/payment/verify`, { token: customer.token, body: verify });
    expect(verified.status).toBe(200);
    expect(verified.json.data.outcome).toBe("PAID");
    expect(verified.json.data.order).toMatchObject({ status: "paid", paymentStatus: "PAID", awaitingPayment: false });

    // The same callback again (double click, page refresh) is harmless.
    const again = await call(`/api/v1/orders/${order.id}/payment/verify`, { token: customer.token, body: verify });
    expect(again.json.data.outcome).toBe("ALREADY_PAID");
    const captured = await env.DB.prepare(`SELECT COUNT(*) AS n FROM payments WHERE order_id = ? AND status = 'CAPTURED'`).bind(order.id).first<{ n: number }>();
    expect(captured?.n).toBe(1);
  });

  it("does not accept a payment from a different order", async () => {
    const first = await shopper();
    const second = await shopper();
    const a = await placeOnline(first.customer.token);
    const b = await placeOnline(second.customer.token);
    const { verify } = await gateway.pay(b.payment.razorpayOrderId);
    const result = await call(`/api/v1/orders/${a.id}/payment/verify`, { token: first.customer.token, body: verify });
    expect(result.status).toBe(400);
  });

  it("captures an authorised payment and refuses an amount mismatch", async () => {
    const one = await shopper();
    const order = await placeOnline(one.customer.token);
    const { verify } = await gateway.pay(order.payment.razorpayOrderId, { status: "authorized" });
    const result = await call(`/api/v1/orders/${order.id}/payment/verify`, { token: one.customer.token, body: verify });
    expect(result.json.data.outcome).toBe("PAID");
    expect(gateway.calls.some((entry) => entry.endsWith("/capture"))).toBe(true);

    const two = await shopper();
    const short = await placeOnline(two.customer.token);
    const underpaid = await gateway.pay(short.payment.razorpayOrderId, { amount: 100 });
    const mismatch = await call(`/api/v1/orders/${short.id}/payment/verify`, { token: two.customer.token, body: underpaid.verify });
    expect(mismatch.json.data.outcome).toBe("MISMATCH");
    expect(mismatch.json.data.order.paymentStatus).not.toBe("PAID");
  });

  it("marks the order paid from the webhook alone, and ignores duplicate deliveries", async () => {
    const { customer } = await shopper();
    const order = await placeOnline(customer.token);
    const { payment } = await gateway.pay(order.payment.razorpayOrderId);

    const unsigned = await call("/api/v1/payments/razorpay/webhook", { rawBody: JSON.stringify({ event: "payment.captured" }), headers: { "x-razorpay-signature": "bad" } });
    expect(unsigned.status).toBe(401);

    const first = await webhook("payment.captured", { payment }, "evt_dup_1");
    expect(first.json.data.result).toBe("processed");
    const duplicate = await webhook("payment.captured", { payment }, "evt_dup_1");
    expect(duplicate.json.data.result).toBe("duplicate");

    const mine = await call(`/api/v1/orders/${order.id}`, { token: customer.token });
    expect(mine.json.data).toMatchObject({ status: "paid", paymentStatus: "PAID" });
    const admin = await createAdmin();
    const detail = await call(`/api/v1/admin/orders/${order.id}`, { token: admin.token });
    expect(detail.json.data.payments).toHaveLength(1);
    expect(detail.json.data.payments[0]).toMatchObject({ status: "CAPTURED", providerPaymentId: payment.id, method: "upi" });
  });

  it("records a failed payment and lets the customer retry on the same gateway order", async () => {
    const { customer } = await shopper();
    const order = await placeOnline(customer.token);
    const failed = await gateway.pay(order.payment.razorpayOrderId, { status: "failed" });
    expect((await webhook("payment.failed", { payment: failed.payment })).json.data.result).toBe("processed");
    expect((await call(`/api/v1/orders/${order.id}`, { token: customer.token })).json.data.status).toBe("payment_failed");

    const retry = await call(`/api/v1/orders/${order.id}/pay`, { token: customer.token, body: {} });
    expect(retry.status).toBe(200);
    expect(retry.json.data.razorpayOrderId).toBe(order.payment.razorpayOrderId);
    expect((await call(`/api/v1/orders/${order.id}`, { token: customer.token })).json.data.status).toBe("payment_pending");

    const ok = await gateway.pay(order.payment.razorpayOrderId);
    const verified = await call(`/api/v1/orders/${order.id}/payment/verify`, { token: customer.token, body: ok.verify });
    expect(verified.json.data.outcome).toBe("PAID");
  });

  it("puts the bag back when the gateway is down", async () => {
    const { customer, product } = await shopper();
    gateway.options.failOrderCreate = true;
    const result = await call("/api/v1/orders", { token: customer.token, body: { address: ADDRESS, paymentMethod: "RAZORPAY" } });
    expect(result.status).toBe(503);
    expect(await stockOf(product.id)).toBe(5);
    const cart = await call("/api/v1/cart", { token: customer.token });
    expect(cart.json.data.items).toHaveLength(1);
  });

  it("expires unpaid orders after the window, but honours a payment that did go through", async () => {
    const one = await shopper();
    const abandoned = await placeOnline(one.customer.token);
    const two = await shopper();
    const paidLate = await placeOnline(two.customer.token);
    await gateway.pay(paidLate.payment.razorpayOrderId);
    await env.DB.prepare(`UPDATE orders SET payment_expires_at = ? WHERE id IN (?, ?)`).bind(Date.now() - 60_000, abandoned.id, paidLate.id).run();

    const ctx = createExecutionContext();
    await expirePayments(env, ctx);
    await waitOnExecutionContext(ctx);

    expect((await call(`/api/v1/orders/${abandoned.id}`, { token: one.customer.token })).json.data.status).toBe("cancelled");
    expect(await stockOf(one.product.id)).toBe(5);
    expect((await call(`/api/v1/orders/${paidLate.id}`, { token: two.customer.token })).json.data.status).toBe("paid");
    expect(await stockOf(two.product.id)).toBe(4);
  });
});

describe("refunds", () => {
  it("cancelling a paid order raises a refund that an approver sends to Razorpay exactly once", async () => {
    const { customer, product } = await shopper();
    const order = await placeOnline(customer.token);
    const { verify, payment } = await gateway.pay(order.payment.razorpayOrderId);
    await call(`/api/v1/orders/${order.id}/payment/verify`, { token: customer.token, body: verify });

    const cancelled = await call(`/api/v1/orders/${order.id}/cancel`, { token: customer.token, body: { reason: "Changed my mind" } });
    expect(cancelled.status).toBe(200);
    expect(cancelled.json.data).toMatchObject({ status: "refund_pending", paymentStatus: "REFUND_PENDING" });
    expect(await stockOf(product.id)).toBe(5);

    const approver = await createAdmin("MANAGER");
    const list = await call("/api/v1/admin/payments/refunds/all?status=REQUESTED", { token: approver.token });
    const refund = list.json.data.find((entry: { order: { id: string } }) => entry.order.id === order.id);
    expect(refund).toMatchObject({ status: "REQUESTED", amount: order.totals.total });
    expect(list.json.meta?.pendingCount).toBeGreaterThan(0);

    const support = await createAdmin("SUPPORT");
    expect((await call(`/api/v1/admin/payments/refunds/${refund.id}/approve`, { token: support.token, body: {} })).status).toBe(403);

    const approved = await call(`/api/v1/admin/payments/refunds/${refund.id}/approve`, { token: approver.token, body: {} });
    expect(approved.status).toBe(200);
    expect(approved.json.data.status).toBe("COMPLETED");
    expect(gateway.payments.get(payment.id)?.amount_refunded).toBe(order.payment.amount);
    expect((await call(`/api/v1/admin/payments/refunds/${refund.id}/approve`, { token: approver.token, body: {} })).status).toBe(409);
    expect([...gateway.refunds.values()].filter((entry) => entry.payment_id === payment.id)).toHaveLength(1);

    const after = await call(`/api/v1/orders/${order.id}`, { token: customer.token });
    expect(after.json.data).toMatchObject({ status: "refunded", paymentStatus: "REFUNDED" });
    expect(after.json.data.totals.refunded).toBe(order.totals.total);

    // A late refund.processed webhook for the same refund changes nothing.
    const [gatewayRefund] = [...gateway.refunds.values()];
    expect((await webhook("refund.processed", { refund: gatewayRefund })).status).toBe(200);
    const totals = await env.DB.prepare(`SELECT refunded_paise, total_paise FROM orders WHERE id = ?`).bind(order.id).first<{ refunded_paise: number; total_paise: number }>();
    expect(totals?.refunded_paise).toBe(totals?.total_paise);
  });

  it("explains a refund Razorpay declines and lets the admin approve it again later", async () => {
    const { customer } = await shopper();
    const order = await placeOnline(customer.token);
    const { verify, payment } = await gateway.pay(order.payment.razorpayOrderId);
    await call(`/api/v1/orders/${order.id}/payment/verify`, { token: customer.token, body: verify });
    const admin = await createAdmin("MANAGER");
    expect((await call(`/api/v1/admin/orders/${order.id}/refund`, { token: admin.token, body: { reason: "Damaged in transit" } })).status).toBe(200);
    const refund = (await call(`/api/v1/admin/orders/${order.id}`, { token: admin.token })).json.data.refunds[0];

    gateway.options.declineRefunds = true;
    const declined = await call(`/api/v1/admin/payments/refunds/${refund.id}/approve`, { token: admin.token, body: {} });
    expect(declined.status).toBe(503);
    expect(declined.json.error?.code).toBe("REFUND_FAILED");
    expect(declined.json.error?.message).toMatch(/account balance/);
    const failed = (await call(`/api/v1/admin/orders/${order.id}`, { token: admin.token })).json.data;
    expect(failed.refunds[0]).toMatchObject({ status: "FAILED", failureReason: expect.stringMatching(/account balance/) });
    expect(failed.paymentStatus).toBe("REFUND_PENDING");

    gateway.options.declineRefunds = false;
    const retried = await call(`/api/v1/admin/payments/refunds/${refund.id}/approve`, { token: admin.token, body: {} });
    expect(retried.json.data.status).toBe("COMPLETED");
    expect(gateway.payments.get(payment.id)?.amount_refunded).toBe(order.payment.amount);
  });

  it("a rejected refund restores the order's previous state", async () => {
    const { customer } = await shopper();
    const order = await placeOnline(customer.token);
    const { verify } = await gateway.pay(order.payment.razorpayOrderId);
    await call(`/api/v1/orders/${order.id}/payment/verify`, { token: customer.token, body: verify });
    const admin = await createAdmin();
    const requested = await call(`/api/v1/admin/orders/${order.id}/refund`, { token: admin.token, body: { amount: 500, reason: "Goodwill" } });
    expect(requested.status).toBe(200);
    expect(requested.json.data.paymentStatus).toBe("REFUND_PENDING");
    const refund = requested.json.data.refunds.find((entry: { status: string }) => entry.status === "REQUESTED");
    expect(refund.amount).toBe(500);
    expect((await call(`/api/v1/admin/orders/${order.id}/refund`, { token: admin.token, body: { amount: 100, reason: "Twice" } })).status).toBe(409);
    const rejected = await call(`/api/v1/admin/payments/refunds/${refund.id}/reject`, { token: admin.token, body: { reason: "Not eligible" } });
    expect(rejected.json.data.status).toBe("REJECTED");
    const detail = await call(`/api/v1/admin/orders/${order.id}`, { token: admin.token });
    expect(detail.json.data).toMatchObject({ status: "PAID", paymentStatus: "PAID" });
  });
});

describe("delivery, returns and COD", () => {
  it("walks a COD order to delivery, accepts a return, restocks and refunds manually", async () => {
    const { admin, customer, product } = await shopper(2);
    const placed = await call("/api/v1/orders", { token: customer.token, body: { address: ADDRESS, paymentMethod: "COD" } });
    expect(placed.status).toBe(201);
    const id = placed.json.data.id as string;
    expect(placed.json.data).toMatchObject({ status: "pending", paymentStatus: "UNPAID" });
    expect(await stockOf(product.id)).toBe(3);

    expect((await adminStatus(admin.token, id, "PROCESSING")).status).toBe(200);
    expect((await adminStatus(admin.token, id, "PACKED")).status).toBe(200);
    expect((await adminStatus(admin.token, id, "SHIPPED")).status).toBe(409);
    expect((await adminStatus(admin.token, id, "SHIPPED", { trackingNumber: "BD123456", carrier: "Bluedart", trackingUrl: "https://track.example.com/BD123456" })).status).toBe(200);
    expect((await adminStatus(admin.token, id, "OUT_FOR_DELIVERY")).status).toBe(200);
    const delivered = await adminStatus(admin.token, id, "DELIVERED");
    expect(delivered.json.data).toMatchObject({ status: "DELIVERED", paymentStatus: "PAID" });

    const tracking = await call(`/api/v1/orders/${id}`, { token: customer.token });
    expect(tracking.json.data).toMatchObject({ trackingNumber: "BD123456", trackingUrl: "https://track.example.com/BD123456", canReturn: true });
    expect(tracking.json.data.history.map((entry: { to: string }) => entry.to)).toEqual(["pending", "processing", "packed", "shipped", "out_for_delivery", "delivered"]);

    const returned = await call(`/api/v1/orders/${id}/return`, { token: customer.token, body: { reason: "Colour differs from photos" } });
    expect(returned.json.data.status).toBe("return_requested");

    const received = await adminStatus(admin.token, id, "RETURNED", { note: "Parcel received in good condition" });
    expect(received.status).toBe(200);
    expect(await stockOf(product.id)).toBe(5);
    expect(received.json.data.paymentStatus).toBe("REFUND_PENDING");

    const refund = received.json.data.refunds.find((entry: { status: string }) => entry.status === "REQUESTED");
    const approved = await call(`/api/v1/admin/payments/refunds/${refund.id}/approve`, { token: admin.token, body: {} });
    expect(approved.json.data).toMatchObject({ status: "COMPLETED", provider: "manual" });
    const final = await call(`/api/v1/orders/${id}`, { token: customer.token });
    expect(final.json.data).toMatchObject({ status: "refunded", paymentStatus: "REFUNDED" });
  });

  it("sends order updates to the account email when the address has none", async () => {
    const { customer } = await shopper();
    const { email: _omitted, ...withoutEmail } = ADDRESS;
    const placed = await call("/api/v1/orders", { token: customer.token, body: { address: { ...withoutEmail, email: "" }, paymentMethod: "COD" } });
    expect(placed.status).toBe(201);
    const stored = await env.DB.prepare(`SELECT shipping_email FROM orders WHERE id = ?`).bind(placed.json.data.id).first<{ shipping_email: string }>();
    expect(stored?.shipping_email).toBe(customer.email);
  });

  it("rejects a return outside delivered orders and orders over the COD limit", async () => {
    const { customer } = await shopper();
    const placed = await call("/api/v1/orders", { token: customer.token, body: { address: ADDRESS, paymentMethod: "COD" } });
    expect((await call(`/api/v1/orders/${placed.json.data.id}/return`, { token: customer.token, body: { reason: "Too early" } })).status).toBe(409);

    const big = await shopper(5, { price: 9000 });
    const tooBig = await call("/api/v1/orders", { token: big.customer.token, body: { address: ADDRESS, paymentMethod: "COD" } });
    expect(tooBig.status).toBe(422);
  });
});

describe("coupons", () => {
  it("applies a server-validated discount and enforces per-customer limits", async () => {
    const admin = await createAdmin();
    const code = `SAVE${Date.now().toString(36).toUpperCase()}`;
    const coupon = await call("/api/v1/admin/coupons", { token: admin.token, body: { code, label: "Ten off", type: "PERCENT", value: 10, perUserLimit: 1, isActive: true } });
    expect(coupon.status).toBe(201);
    expect((await call("/api/v1/admin/coupons", { token: admin.token, body: { code, label: "Dup", type: "FIXED", value: 100 } })).status).toBe(409);

    const { customer, variantId } = await shopper();
    expect((await call("/api/v1/cart/coupon", { token: customer.token, body: { code: "NOPE-NOT-REAL" } })).status).toBe(409);
    const applied = await call("/api/v1/cart/coupon", { token: customer.token, body: { code: code.toLowerCase() } });
    expect(applied.status).toBe(200);
    expect(applied.json.data.totals.discount).toBe(250);

    const placed = await call("/api/v1/orders", { token: customer.token, body: { address: ADDRESS, paymentMethod: "COD" } });
    expect(placed.status).toBe(201);
    expect(placed.json.data.totals.discount).toBe(250);
    expect(placed.json.data.couponCode).toBe(code);
    const used = await env.DB.prepare(`SELECT used_count FROM coupons WHERE code = ?`).bind(code).first<{ used_count: number }>();
    expect(used?.used_count).toBe(1);

    await call("/api/v1/cart/items", { token: customer.token, body: { variantId, quantity: 1 } });
    const second = await call("/api/v1/orders", { token: customer.token, body: { address: ADDRESS, paymentMethod: "COD", couponCode: code } });
    expect(second.status).toBe(409);
    expect(second.json.error?.code).toBe("COUPON_LIMIT_REACHED");

    // Cancelling the unpaid first order gives the use back.
    await call(`/api/v1/orders/${placed.json.data.id}/cancel`, { token: customer.token, body: {} });
    const released = await env.DB.prepare(`SELECT used_count FROM coupons WHERE code = ?`).bind(code).first<{ used_count: number }>();
    expect(released?.used_count).toBe(0);
  });
});

describe("password recovery and login activity", () => {
  it("resets a password with a single-use token and signs out every session", async () => {
    const customer = await registerCustomer();
    const token = `pr_${crypto.randomUUID().replace(/-/g, "")}`;
    await env.DB.prepare(`INSERT INTO password_resets (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)`)
      .bind(newId(), customer.user.id, await sha256Hex(token), Date.now() + 600_000)
      .run();

    const weak = await call("/api/v1/auth/reset-password", { body: { token, password: "short" } });
    expect(weak.status).toBe(422);
    const reset = await call("/api/v1/auth/reset-password", { body: { token, password: "New-Pashmina-2026!" } });
    expect(reset.status).toBe(200);
    expect((await call("/api/v1/auth/me", { token: customer.token })).status).toBe(401);
    expect((await call("/api/v1/auth/reset-password", { body: { token, password: "Another-Pass-2026!" } })).status).toBe(400);
    expect((await call("/api/v1/auth/login", { body: { email: customer.email, password: STRONG_PASSWORD } })).status).toBe(401);
    expect((await call("/api/v1/auth/login", { body: { email: customer.email, password: "New-Pashmina-2026!" } })).status).toBe(200);

    const admin = await createAdmin();
    const activity = await call(`/api/v1/admin/login-activity?userId=${customer.user.id}`, { token: admin.token });
    const events = activity.json.data.map((entry: { event: string }) => entry.event);
    expect(events).toEqual(expect.arrayContaining(["REGISTER", "PASSWORD_RESET", "LOGIN_FAILED", "LOGIN"]));
    const detail = await call(`/api/v1/admin/customers/${customer.user.id}`, { token: admin.token });
    expect(detail.json.data.loginActivity.length).toBeGreaterThan(0);
    expect(JSON.stringify(detail.json.data)).not.toMatch(/password_hash|New-Pashmina/);
  });

  it("finds every sign-in event, including sign-outs, when admins search by email", async () => {
    const customer = await registerCustomer();
    expect((await call("/api/v1/auth/logout", { body: { refreshToken: customer.refreshToken } })).status).toBe(200);
    const admin = await createAdmin();
    const activity = await call(`/api/v1/admin/login-activity?q=${encodeURIComponent(customer.email)}`, { token: admin.token });
    const events = activity.json.data.map((entry: { event: string }) => entry.event);
    expect(events).toEqual(expect.arrayContaining(["REGISTER", "LOGOUT"]));
  });

  it("rejects an expired reset token", async () => {
    const customer = await registerCustomer();
    const token = `pr_${crypto.randomUUID().replace(/-/g, "")}`;
    await env.DB.prepare(`INSERT INTO password_resets (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)`)
      .bind(newId(), customer.user.id, await sha256Hex(token), Date.now() - 1)
      .run();
    expect((await call("/api/v1/auth/reset-password", { body: { token, password: "New-Pashmina-2026!" } })).status).toBe(400);
  });
});

describe("website content", () => {
  it("publishes banners, settings and pages to the storefront immediately", async () => {
    const admin = await createAdmin();
    const heading = `Winter edit ${Date.now()}`;
    const banner = await call("/api/v1/admin/content/banners", {
      token: admin.token,
      body: { placement: "HOME_HERO", heading, imageUrl: "/images/hero.jpg", href: "/collections/winter", ctaLabel: "Shop", isActive: true },
    });
    expect(banner.status).toBe(201);
    let home = await call("/api/v1/content/home");
    expect(home.json.data.banners.HOME_HERO.map((entry: { heading: string }) => entry.heading)).toContain(heading);

    await call(`/api/v1/admin/content/banners/${banner.json.data.id}`, { method: "PATCH", token: admin.token, body: { isActive: false } });
    home = await call("/api/v1/content/home");
    expect((home.json.data.banners.HOME_HERO ?? []).map((entry: { heading: string }) => entry.heading)).not.toContain(heading);

    const video = await call("/api/v1/admin/content/banners", { token: admin.token, body: { placement: "HOME_FEATURED", heading: "Film", mediaType: "VIDEO" } });
    expect(video.status).toBe(422);

    const saved = await call("/api/v1/admin/content/settings", { method: "PUT", token: admin.token, body: { settings: [{ key: "commerce.freeShippingThreshold", value: 2000 }] } });
    expect(saved.status).toBe(200);
    const site = await call("/api/v1/content/site");
    expect(site.json.data.commerce.freeShippingThreshold).toBe(2000);
    expect(site.json.data.payments).toEqual({ razorpay: true, cod: true });
    const bad = await call("/api/v1/admin/content/settings", { method: "PUT", token: admin.token, body: { settings: [{ key: "commerce.freeShippingThreshold", value: -5 }] } });
    expect(bad.status).toBe(422);
    await call("/api/v1/admin/content/settings", { method: "PUT", token: admin.token, body: { settings: [{ key: "commerce.freeShippingThreshold", value: 4999 }] } });

    const editor = await createAdmin("EDITOR");
    expect((await call("/api/v1/admin/content/settings", { method: "PUT", token: editor.token, body: { settings: [{ key: "store.name", value: "X" }] } })).status).toBe(403);
    expect((await call("/api/v1/admin/orders", { token: editor.token })).status).toBe(403);
  });

  it("targets page banners at a page, a section or every page", async () => {
    const admin = await createAdmin();
    const base = { placement: "PAGE_BANNER", imageUrl: "/images/hero.jpg", isActive: true };

    const missing = await call("/api/v1/admin/content/banners", { token: admin.token, body: { ...base, heading: "No page" } });
    expect(missing.status).toBe(422);
    const invalid = await call("/api/v1/admin/content/banners", { token: admin.token, body: { ...base, heading: "Bad page", pagePath: "about us" } });
    expect(invalid.status).toBe(422);

    const about = await call("/api/v1/admin/content/banners", { token: admin.token, body: { ...base, heading: "About", pagePath: "/About/" } });
    expect(about.status).toBe(201);
    expect(about.json.data.pagePath).toBe("/about");
    const section = await call("/api/v1/admin/content/banners", { token: admin.token, body: { ...base, heading: "Collections", pagePath: "/collections/*" } });
    expect(section.json.data.pagePath).toBe("/collections/*");

    const listed = await call("/api/v1/content/banners?placement=PAGE_BANNER");
    expect(listed.json.data.map((entry: { pagePath: string }) => entry.pagePath)).toEqual(expect.arrayContaining(["/about", "/collections/*"]));

    const moved = await call(`/api/v1/admin/content/banners/${about.json.data.id}`, { method: "PATCH", token: admin.token, body: { placement: "HOME_HERO" } });
    expect(moved.json.data.pagePath).toBeNull();
  });

  it("stores contact enquiries and newsletter sign-ups for the admin", async () => {
    const email = `visitor.${Date.now()}@example.com`;
    const short = await call("/api/v1/contact", { body: { name: "Riya", email, subject: "Order enquiry", message: "Too short" } });
    expect(short.status).toBe(422);
    const sent = await call("/api/v1/contact", { body: { name: "Riya", email, subject: "Order enquiry", message: "Could you tell me when my shawl will be dispatched please?" } });
    expect(sent.status).toBe(201);
    expect((await call("/api/v1/newsletter", { body: { email } })).status).toBe(200);
    expect((await call("/api/v1/newsletter", { body: { email } })).status).toBe(200);

    const admin = await createAdmin();
    const enquiries = await call(`/api/v1/admin/contact?q=${encodeURIComponent(email)}`, { token: admin.token });
    expect(enquiries.json.data).toHaveLength(1);
    const updated = await call(`/api/v1/admin/contact/${enquiries.json.data[0].id}`, { method: "PATCH", token: admin.token, body: { status: "REPLIED", adminNotes: "Emailed" } });
    expect(updated.json.data.status).toBe("REPLIED");
    const subscribers = await call(`/api/v1/admin/newsletter?q=${encodeURIComponent(email)}`, { token: admin.token });
    expect(subscribers.json.data).toHaveLength(1);
    const csv = await call("/api/v1/admin/newsletter/export", { token: admin.token });
    expect(csv.text).toContain(email);
  });
});

describe("reports and media", () => {
  it("reports payments, fulfilment and sales with CSV export", async () => {
    const { admin, customer } = await shopper();
    const order = await placeOnline(customer.token);
    const { verify } = await gateway.pay(order.payment.razorpayOrderId);
    await call(`/api/v1/orders/${order.id}/payment/verify`, { token: customer.token, body: verify });

    const dashboard = await call("/api/v1/admin/dashboard?days=7", { token: admin.token });
    expect(dashboard.status).toBe(200);
    expect(dashboard.json.data.payments.successful).toBeGreaterThan(0);
    expect(dashboard.json.data.fulfilment.statusCounts.PAID).toBeGreaterThan(0);
    expect(dashboard.json.data.recentRegistrations.length).toBeGreaterThan(0);

    const payments = await call("/api/v1/admin/payments?status=CAPTURED", { token: admin.token });
    expect(payments.json.data.some((entry: { order: { id: string } }) => entry.order.id === order.id)).toBe(true);
    expect(payments.json.meta?.byStatus.find((entry: { status: string }) => entry.status === "CAPTURED")?.count).toBeGreaterThan(0);

    const today = new Date().toISOString().slice(0, 10);
    const report = await call(`/api/v1/admin/reports?type=sales&from=${today}&to=${today}`, { token: admin.token });
    expect(report.json.data[0]).toMatchObject({ day: today });
    const csv = await call(`/api/v1/admin/reports/export?type=payments&from=${today}&to=${today}`, { token: admin.token });
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.text.split("\r\n")[0]).toBe("provider,method,status,currency,count,amount,refunded");
  });

  it("uploads a video and streams it with byte ranges", async () => {
    const admin = await createAdmin();
    const bytes = new Uint8Array(4096);
    bytes.set([0, 0, 0, 0x20, ...new TextEncoder().encode("ftypisom")], 0);
    const form = new FormData();
    form.append("files", new File([bytes], "film.mp4", { type: "video/mp4" }));
    form.append("folder", "banners");
    const upload = await call("/api/v1/admin/media", { token: admin.token, form });
    expect(upload.status).toBe(201);
    expect(upload.json.data[0]).toMatchObject({ mimeType: "video/mp4", folder: "banners" });

    const path = upload.json.data[0].path as string;
    const ranged = await call(path, { headers: { range: "bytes=0-99" } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe("bytes 0-99/4096");

    const fake = new FormData();
    fake.append("files", new File([new Uint8Array(4096)], "film.mp4", { type: "video/mp4" }));
    expect((await call("/api/v1/admin/media", { token: admin.token, form: fake })).status).toBe(400);
  });

  it("daily cleanup runs against the new tables", async () => {
    await cleanup(env);
  });
});
