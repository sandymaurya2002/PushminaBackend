import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADDRESS, call, createAdmin, createProduct, registerCustomer } from "./helpers";
import { installRazorpayMock, type RazorpayMock } from "./razorpay-mock";

let gateway: RazorpayMock;
beforeEach(() => {
  gateway = installRazorpayMock();
});
afterEach(() => gateway.restore());

const IN = { "x-client-country": "IN" };
const US = { "x-client-country": "US" };

const US_ADDRESS = {
  fullName: "Emily Carter",
  email: "emily@example.com",
  phone: "+1 212 555 0100",
  line1: "350 Fifth Avenue",
  city: "New York",
  state: "NY",
  postalCode: "10118",
  country: "United States",
};

async function shopperIn(headers: Record<string, string>, productOverrides: Record<string, unknown> = {}) {
  const admin = await createAdmin();
  const customer = await registerCustomer();
  const product = await createProduct(admin.token, productOverrides);
  const variantId = product.raw.variants[0]!.id;
  const added = await call("/api/v1/cart/items", { token: customer.token, headers, body: { variantId, quantity: 1 } });
  return { admin, customer, product, variantId, added };
}

describe("admin product prices", () => {
  it("requires both prices on create and keeps the USD price when an update omits it", async () => {
    const admin = await createAdmin();
    const missing = await call("/api/v1/admin/products", { token: admin.token, body: { name: "No dollars", price: 1000, variants: [{ sku: `NOUSD-${Date.now()}`, inventory: 1 }] } });
    expect(missing.status).toBe(422);
    expect(missing.json.error?.details?.priceUsd).toBeTruthy();

    const product = await createProduct(admin.token, { price: 8999, priceUsd: 129.5, compareAtPriceUsd: 159 });
    const detail = await call(`/api/v1/admin/products/${product.id}`, { token: admin.token });
    expect(detail.json.data).toMatchObject({ price: 8999, priceUsd: 129.5, compareAtPriceUsd: 159 });

    const badCompare = await call(`/api/v1/admin/products/${product.id}`, { method: "PATCH", token: admin.token, body: { ...detail.json.data.raw, name: detail.json.data.name, price: 8999, compareAtPriceUsd: 100, categoryId: detail.json.data.raw.categoryId, images: [{ url: "https://images.example.com/shawl.jpg" }], status: "PUBLISHED" } });
    expect(badCompare.status).toBe(422);
    expect(badCompare.json.error?.details?.compareAtPriceUsd).toBeTruthy();

    const inrOnly = await call(`/api/v1/admin/products/${product.id}`, {
      method: "PUT",
      token: admin.token,
      body: { name: detail.json.data.name, slug: product.slug, price: 9499, status: "PUBLISHED", categoryId: detail.json.data.raw.categoryId, images: [{ url: "https://images.example.com/shawl.jpg" }], variants: detail.json.data.raw.variants },
    });
    expect(inrOnly.status).toBe(200);
    expect(inrOnly.json.data).toMatchObject({ price: 9499, priceUsd: 129.5, compareAtPriceUsd: 159 });

    const usdOnly = await call(`/api/v1/admin/products/${product.id}`, {
      method: "PUT",
      token: admin.token,
      body: { name: detail.json.data.name, slug: product.slug, price: 9499, priceUsd: 139, compareAtPriceUsd: null, status: "PUBLISHED", categoryId: detail.json.data.raw.categoryId, images: [{ url: "https://images.example.com/shawl.jpg" }], variants: detail.json.data.raw.variants },
    });
    expect(usdOnly.json.data).toMatchObject({ price: 9499, priceUsd: 139, compareAtPriceUsd: null });
  });

  it("lists products that still need an international price", async () => {
    const admin = await createAdmin();
    const product = await createProduct(admin.token);
    await env.DB.prepare(`UPDATE products SET price_usd_cents = NULL WHERE id = ?`).bind(product.id).run();
    const list = await call(`/api/v1/admin/products?pricing=missing-usd&limit=100`, { token: admin.token });
    expect(list.json.data.map((row: { id: string }) => row.id)).toContain(product.id);
    expect(list.json.meta?.counts.missingUsd).toBeGreaterThan(0);
  });
});

describe("regional catalogue", () => {
  it("prices India in rupees and everywhere else in dollars, from the separately entered prices", async () => {
    const admin = await createAdmin();
    const product = await createProduct(admin.token, { price: 2500, priceUsd: 30 });

    const india = await call(`/api/v1/products/${product.slug}`, { headers: IN });
    expect(india.json.data).toMatchObject({ price: 2500, currency: "INR", availableInRegion: true });
    const abroad = await call(`/api/v1/products/${product.slug}`, { headers: US });
    expect(abroad.json.data).toMatchObject({ price: 30, currency: "USD", availableInRegion: true });
    expect(abroad.json.data.variants[0].price).toBe(30);
    expect(abroad.headers.get("vary")).toContain("X-Client-Country");

    // An explicit currency wins (the storefront uses it to key its cache).
    expect((await call(`/api/v1/products/${product.slug}?currency=USD`, { headers: IN })).json.data.currency).toBe("USD");
    // Unknown country keeps the home currency.
    expect((await call(`/api/v1/products/${product.slug}`, { headers: { "x-client-country": "XX" } })).json.data.currency).toBe("INR");
  });

  it("does not offer a product abroad until it has a USD price", async () => {
    const admin = await createAdmin();
    const product = await createProduct(admin.token);
    await env.DB.prepare(`UPDATE products SET price_usd_cents = NULL WHERE id = ?`).bind(product.id).run();

    const slugsIn = (await call(`/api/v1/products?limit=100&q=${encodeURIComponent(product.slug)}`, { headers: IN })).json.data.map((p: { slug: string }) => p.slug);
    const slugsUs = (await call(`/api/v1/products?limit=100&q=${encodeURIComponent(product.slug)}`, { headers: US })).json.data.map((p: { slug: string }) => p.slug);
    expect(slugsIn).toContain(product.slug);
    expect(slugsUs).not.toContain(product.slug);

    const detail = await call(`/api/v1/products/${product.slug}`, { headers: US });
    expect(detail.status).toBe(200);
    expect(detail.json.data).toMatchObject({ availableInRegion: false, currency: "USD" });

    const customer = await registerCustomer();
    const added = await call("/api/v1/cart/items", { token: customer.token, headers: US, body: { variantId: product.raw.variants[0]!.id, quantity: 1 } });
    expect(added.status).toBe(409);
    expect(added.json.error?.code).toBe("REGION_UNAVAILABLE");
  });
});

describe("cart and checkout in dollars", () => {
  it("totals the bag in the shopper's currency with that currency's shipping rules", async () => {
    const { customer } = await shopperIn(US, { price: 2500, priceUsd: 30 });
    const usd = await call("/api/v1/cart", { token: customer.token, headers: US });
    expect(usd.json.data.currency).toBe("USD");
    expect(usd.json.data.items[0]).toMatchObject({ unitPrice: 30, lineTotal: 30 });
    expect(usd.json.data.totals).toMatchObject({ subtotal: 30, shipping: 25, total: 55 });

    // The same bag viewed from India is priced from the INR list, not converted.
    const inr = await call("/api/v1/cart", { token: customer.token, headers: IN });
    expect(inr.json.data.currency).toBe("INR");
    expect(inr.json.data.totals).toMatchObject({ subtotal: 2500, shipping: 149, total: 2649 });
  });

  it("charges an international order in USD through Razorpay and snapshots its prices", async () => {
    const { admin, customer, product } = await shopperIn(US, { price: 2500, priceUsd: 30 });

    const mismatch = await call("/api/v1/orders", { token: customer.token, headers: US, body: { address: ADDRESS, paymentMethod: "RAZORPAY" } });
    expect(mismatch.status).toBe(409);
    expect(mismatch.json.error?.code).toBe("REGION_MISMATCH");

    const cod = await call("/api/v1/orders", { token: customer.token, headers: US, body: { address: US_ADDRESS, paymentMethod: "COD" } });
    expect(cod.status).toBe(422);

    const changed = await call("/api/v1/orders", { token: customer.token, headers: US, body: { address: US_ADDRESS, paymentMethod: "RAZORPAY", currency: "INR" } });
    expect(changed.json.error?.code).toBe("CURRENCY_CHANGED");

    const placed = await call("/api/v1/orders", { token: customer.token, headers: US, body: { address: US_ADDRESS, paymentMethod: "RAZORPAY", currency: "USD" } });
    expect(placed.status).toBe(201);
    const order = placed.json.data;
    expect(order.currency).toBe("USD");
    expect(order.totals).toMatchObject({ subtotal: 30, shipping: 25, total: 55 });
    expect(order.items[0]).toMatchObject({ unitPrice: 30, currency: "USD" });
    expect(order.payment).toMatchObject({ currency: "USD", amount: 5500 });
    expect(gateway.orders.get(order.payment.razorpayOrderId)).toMatchObject({ amount: 5500, currency: "USD" });

    // A payment in the wrong currency is never accepted as payment in full.
    const wrong = await gateway.pay(order.payment.razorpayOrderId, { currency: "INR" });
    const refused = await call(`/api/v1/orders/${order.id}/payment/verify`, { token: customer.token, body: wrong.verify });
    expect(refused.json.data.outcome).toBe("MISMATCH");

    const fresh = await call("/api/v1/cart/items", { token: customer.token, headers: US, body: { variantId: product.raw.variants[0]!.id, quantity: 1 } });
    expect(fresh.status).toBe(200);
    const second = await call("/api/v1/orders", { token: customer.token, headers: US, body: { address: US_ADDRESS, paymentMethod: "RAZORPAY" } });
    const { verify } = await gateway.pay(second.json.data.payment.razorpayOrderId);
    const paid = await call(`/api/v1/orders/${second.json.data.id}/payment/verify`, { token: customer.token, body: verify });
    expect(paid.json.data.outcome).toBe("PAID");
    const payment = await env.DB.prepare(`SELECT currency, amount_paise FROM payments WHERE order_id = ? AND status = 'CAPTURED'`).bind(second.json.data.id).first();
    expect(payment).toMatchObject({ currency: "USD", amount_paise: 5500 });
    const stored = await env.DB.prepare(`SELECT currency, pricing_country FROM orders WHERE id = ?`).bind(second.json.data.id).first();
    expect(stored).toMatchObject({ currency: "USD", pricing_country: "US" });

    // Later price changes leave placed orders untouched.
    const detail = (await call(`/api/v1/admin/products/${product.id}`, { token: admin.token })).json.data;
    await call(`/api/v1/admin/products/${product.id}`, {
      method: "PUT",
      token: admin.token,
      body: { name: detail.name, slug: product.slug, price: 3100, priceUsd: 45, status: "PUBLISHED", categoryId: detail.raw.categoryId, images: [{ url: "https://images.example.com/shawl.jpg" }], variants: detail.raw.variants },
    });
    const history = await call(`/api/v1/orders/${second.json.data.id}`, { token: customer.token, headers: IN });
    expect(history.json.data).toMatchObject({ currency: "USD", totals: { subtotal: 30, total: 55 } });
    const adminView = await call(`/api/v1/admin/orders/${second.json.data.id}`, { token: admin.token });
    expect(adminView.json.data).toMatchObject({ currency: "USD", total: 55, pricingCountry: "US" });
    expect(adminView.json.data.payments[0]).toMatchObject({ currency: "USD", amount: 55 });
  });

  it("keeps Indian orders in rupees with cash on delivery available", async () => {
    const { customer } = await shopperIn(IN, { price: 2500, priceUsd: 30 });
    const placed = await call("/api/v1/orders", { token: customer.token, headers: IN, body: { address: ADDRESS, paymentMethod: "COD" } });
    expect(placed.status).toBe(201);
    expect(placed.json.data).toMatchObject({ currency: "INR", totals: { subtotal: 2500, total: 2649 } });

    // Shipping abroad while browsing in rupees must switch region first, so the dollar prices are seen before paying.
    const { customer: other } = await shopperIn(IN);
    const abroad = await call("/api/v1/orders", { token: other.token, headers: IN, body: { address: US_ADDRESS, paymentMethod: "RAZORPAY" } });
    expect(abroad.status).toBe(409);
    expect(abroad.json.error).toMatchObject({ code: "REGION_MISMATCH", details: { currency: "USD" } });
  });

  it("validates addresses by country", async () => {
    const customer = await registerCustomer();
    const us = await call("/api/v1/auth/addresses", { token: customer.token, body: { ...US_ADDRESS, state: "" } });
    expect(us.status).toBe(201);
    const badPin = await call("/api/v1/auth/addresses", { token: customer.token, body: { ...ADDRESS, postalCode: "1900" } });
    expect(badPin.status).toBe(422);
    expect(badPin.json.error?.details?.postalCode).toBeTruthy();
    const noState = await call("/api/v1/auth/addresses", { token: customer.token, body: { ...ADDRESS, state: "" } });
    expect(noState.json.error?.details?.state).toBeTruthy();
    const moved = await call(`/api/v1/auth/addresses/${us.json.data.id}`, { method: "PATCH", token: customer.token, body: { country: "India" } });
    expect(moved.status).toBe(422);
    const relabelled = await call(`/api/v1/auth/addresses/${us.json.data.id}`, { method: "PATCH", token: customer.token, body: { label: "Office" } });
    expect(relabelled.status).toBe(200);
    expect(relabelled.json.data.country).toBe("United States");
  });
});

describe("coupons and reporting across currencies", () => {
  it("applies percentage codes abroad but keeps rupee-denominated codes in India", async () => {
    const admin = await createAdmin();
    const percent = `PCT${Date.now().toString(36).toUpperCase()}`;
    const fixed = `FIX${Date.now().toString(36).toUpperCase()}`;
    await call("/api/v1/admin/coupons", { token: admin.token, body: { code: percent, label: "Ten off", type: "PERCENT", value: 10, isActive: true } });
    await call("/api/v1/admin/coupons", { token: admin.token, body: { code: fixed, label: "Rs 500 off", type: "FIXED", value: 500, isActive: true } });

    const { customer } = await shopperIn(US, { price: 2500, priceUsd: 30 });
    const rejected = await call("/api/v1/cart/coupon", { token: customer.token, headers: US, body: { code: fixed } });
    expect(rejected.status).toBe(409);
    expect(rejected.json.error?.code).toBe("COUPON_CURRENCY");
    const applied = await call("/api/v1/cart/coupon", { token: customer.token, headers: US, body: { code: percent } });
    expect(applied.status).toBe(200);
    expect(applied.json.data.totals.discount).toBe(3);

    const inIndia = await call("/api/v1/cart/coupon", { token: customer.token, headers: IN, body: { code: fixed } });
    expect(inIndia.status).toBe(200);
    expect(inIndia.json.data.totals.discount).toBe(500);
  });

  it("reports revenue per currency without adding rupees to dollars", async () => {
    const { admin, customer } = await shopperIn(US, { price: 2500, priceUsd: 30 });
    const placed = await call("/api/v1/orders", { token: customer.token, headers: US, body: { address: US_ADDRESS, paymentMethod: "RAZORPAY" } });
    const { verify } = await gateway.pay(placed.json.data.payment.razorpayOrderId);
    await call(`/api/v1/orders/${placed.json.data.id}/payment/verify`, { token: customer.token, body: verify });

    const usd = await call("/api/v1/admin/dashboard?currency=USD", { token: admin.token });
    expect(usd.json.data.currency).toBe("USD");
    expect(usd.json.data.revenue.gross).toBeGreaterThanOrEqual(55);
    const inrGross = (await call("/api/v1/admin/dashboard?currency=INR", { token: admin.token })).json.data.revenue.gross;
    const inrBooked = await env.DB.prepare(
      `SELECT COALESCE(SUM(total_paise), 0) AS n FROM orders WHERE currency = 'INR' AND status NOT IN ('CANCELLED','PAYMENT_PENDING','PAYMENT_FAILED') AND created_at >= datetime('now', '-30 days')`,
    ).first<{ n: number }>();
    expect(inrGross).toBe((inrBooked?.n ?? 0) / 100);

    const today = new Date().toISOString().slice(0, 10);
    const sales = await call(`/api/v1/admin/reports?type=sales&from=${today}&to=${today}`, { token: admin.token });
    expect(sales.json.meta?.columns).toContain("currency");
    expect(sales.json.data.some((row: { currency: string }) => row.currency === "USD")).toBe(true);

    const orders = await call(`/api/v1/admin/orders?currency=USD&limit=100`, { token: admin.token });
    expect(orders.json.data.every((row: { currency: string }) => row.currency === "USD")).toBe(true);
  });

  it("exposes shipping rules for both price lists", async () => {
    const site = await call("/api/v1/content/site");
    expect(site.json.data.commerce.currency).toBe("INR");
    expect(site.json.data.commerceByCurrency.USD).toMatchObject({ currency: "USD", freeShippingThreshold: 250, standardShippingFee: 25, codLimit: 0 });
  });
});
