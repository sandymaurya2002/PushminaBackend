# Pashmore Worker API Reference

The Cloudflare Worker in `worker/` (Hono, D1 `pashmore-db`, R2 `pashmore-media`).

| Environment | Base URL |
| ----------- | -------- |
| Local (`npm run dev` in `worker/`) | `http://127.0.0.1:8787/api/v1` |
| Production | `https://pashmore-api.sandymaurya2002.workers.dev/api/v1` |

The storefront never calls the Worker from the browser: its `/api/*` route handlers call it
server-to-server. The admin dashboard calls `/api/v1/admin/*` directly (through the Vite proxy in
development).

## Conventions

**Envelope.** Every response is `{ "success": true, "data": …, "meta"?: … }` or
`{ "success": false, "error": { "code", "message", "details"? } }`. Paginated lists put
`page`, `limit`, `total` and `totalPages` in `meta`. `details` is keyed by field path.

**Status codes.** `401` not signed in or token expired, `403` missing permission, `404` not
found, `409` conflict (invalid status transition, duplicate, already processed), `422`
validation failed, `429` rate limited (with `Retry-After`), `501` module not available,
`503` schema mismatch, database unreachable or payments not configured.

**Money.** Amounts are in the major unit of their currency: rupees for INR (`8999` = ₹8,999),
dollars for USD (`189` = $189). Every priced response carries `currency` (`INR` or `USD`).
D1 stores the minor unit (paise or cents); Razorpay is called in the order's currency, in its
minor unit.

**Currency and region.** India is priced in INR and every other country in USD. The admin
enters both prices; nothing is ever converted. The Worker picks the currency for a request
from, in order:

1. `?currency=INR|USD` on public catalogue reads (the storefront sends this so its cache holds
   one copy per currency);
2. the `X-Client-Country` header (ISO code), which the storefront sends for the shopper's chosen
   region or, failing that, its own geolocation of the shopper;
3. Cloudflare's geolocation of the caller;
4. INR.

The region is a preference, not a trust boundary. What is enforced is that an order's currency
matches its delivery country: India → INR, anywhere else → USD (`409 REGION_MISMATCH`
otherwise). A product with no USD price is not sold abroad: listings omit it, and detail and
batch reads return it with `availableInRegion: false`. Cash on delivery is India-only.

**Authentication.** `Authorization: Bearer <accessToken>`. Customer and admin tokens are
separate audiences; a customer token never satisfies an admin route. Access tokens last 15
minutes; refresh tokens are single-use and rotated, and reusing one revokes the session.

**Prices and stock are always computed on the server.** Clients send variant IDs and
quantities, never prices. Orders are marked paid only by a verified Razorpay signature, a
signed webhook or a server-side fetch of the payment from Razorpay.

## Health

| Method | Path | Notes |
| ------ | ---- | ----- |
| GET | `/health` | Schema check, enabled checkout methods (`razorpay`, `cod` or `disabled`) and email status. Outside `/api/v1`. |
| GET | `/media/*` | Public R2 objects (images, videos). Outside `/api/v1`. |

## Public: catalogue and content

| Method | Path | Notes |
| ------ | ---- | ----- |
| GET | `/products` | Search and filters: `q`, `category`, `collection`, `color`, `material`, `size`, `pattern`, `availability`, `minPrice`, `maxPrice`, `sort` (`featured`, `newest`, `price-low`, `price-high`, `best-selling`), `page`, `limit`, `currency`. Filter values may be comma-separated or repeated. Price filters and sorting use the request currency. The response includes facet counts, and `meta.currency`. |
| GET | `/products/batch?slugs=a,b` | Live price and stock for several products (guest bag pricing), in the request currency. |
| GET | `/products/:slug` | Product with variants and per-variant `inventory`, `currency` and `availableInRegion`. |
| GET | `/products/:slug/related` | |
| GET | `/collections`, `/collections/:slug`, `/collections/:slug/products` | |
| GET | `/categories`, `/taxonomy` | Filter vocabulary. |
| GET | `/search?q=` | Quick search. |
| GET | `/content/site` | Announcement bar, contact details, social links, shipping and checkout rules. `commerce` holds the India (INR) rules; `commerceByCurrency.INR` / `.USD` hold each region's free-shipping threshold, fees and COD limit (always `0` for USD). |
| GET | `/content/home` | Homepage sections and active banners. |
| GET | `/content/banners` | Active banners (image or video), filterable by `placement`. |
| GET | `/content/pages/:slug` | Published CMS page (shipping, returns, privacy, terms, …). |
| GET | `/content/seo` | Per-path SEO overrides. |
| GET | `/content/redirects` | Active redirects; the storefront middleware applies them. |
| POST | `/contact` | Contact form. 5 per hour per IP; a filled honeypot `website` field is rejected. |
| POST | `/newsletter`, `/newsletter/unsubscribe` | |

## Customer: accounts

| Method | Path | Notes |
| ------ | ---- | ----- |
| POST | `/auth/register` | 5 per 10 minutes per IP. Records a `REGISTER` login event. |
| POST | `/auth/login` | Wrong passwords record `LOGIN_FAILED`; repeated failures lock the account temporarily. |
| POST | `/auth/refresh` | Rotates the refresh token. |
| POST | `/auth/logout`, `/auth/logout-all` | |
| POST | `/auth/forgot-password` | Always answers `200`, so it never reveals whether an email exists. Sends the reset link by email. |
| POST | `/auth/reset-password` | Single-use token; signs out every session. |
| GET/PATCH | `/auth/me` | Profile. |
| POST | `/auth/change-password` | |
| GET/POST | `/auth/addresses` | |
| PATCH/DELETE | `/auth/addresses/:id` | |
| POST | `/auth/addresses/:id/default` | |

## Customer: cart and wishlist

| Method | Path | Notes |
| ------ | ---- | ----- |
| GET | `/cart` | Server-priced cart with shipping and totals, in the request currency (`currency`). A line whose product has no price in that currency is flagged `issue: "REGION_UNAVAILABLE"` and left out of the totals. |
| POST | `/cart/items` | `{ variantId, quantity }`. Rejected when stock is insufficient (max 10 per line), or with `409 REGION_UNAVAILABLE` when the piece is not sold in the shopper's currency. |
| PATCH/DELETE | `/cart/items/:itemId` | |
| DELETE | `/cart` | Empty the cart. |
| POST | `/cart/merge` | Merge guest bag lines at sign-in. |
| GET | `/cart/validate` | Re-checks price and stock before checkout. |
| POST/DELETE | `/cart/coupon` | Apply or remove a discount code. Outside India only percentage codes with no minimum order or maximum discount apply, because those amounts are in rupees. |
| GET/POST/DELETE | `/wishlist`, `/wishlist/slugs`, `/wishlist/toggle`, `/wishlist/merge`, `/wishlist/:slug` | |

## Customer: orders and payments

| Method | Path | Notes |
| ------ | ---- | ----- |
| GET | `/payments/methods` | Which methods are enabled (`razorpay`, `cod`). |
| POST | `/orders` | Places an order from the cart. Body: `addressId` or `address`, `shippingMethod` (`standard`/`express`), `paymentMethod` (`COD` or `RAZORPAY`), optional `couponCode`, `customerNote` and `currency` (the currency the shopper reviewed). Send an `Idempotency-Key` header (8–100 chars `[A-Za-z0-9_-]`); a retry with the same key returns the same order with `meta.replayed: true`. Stock is reserved atomically. The order currency comes from the delivery country and must match the request's region (`409 REGION_MISMATCH`) and the `currency` sent (`409 CURRENCY_CHANGED`); COD outside India is `422`. The order stores its `currency`, the shopper's `pricingCountry` and every price as charged, so later price edits never change it. For Razorpay the response includes `payment` (the Razorpay Checkout options, in the order currency). |
| GET | `/orders`, `/orders/:id` | The customer's own orders, with status history, tracking and refunds. |
| POST | `/orders/:id/pay` | Re-open payment for an order awaiting payment. |
| POST | `/orders/:id/payment/verify` | `{ razorpayOrderId, razorpayPaymentId, razorpaySignature }`. The HMAC is checked and the payment is fetched from Razorpay before the order is marked paid. |
| POST | `/orders/:id/payment/sync` | Asks Razorpay for the latest payment state. |
| POST | `/orders/:id/cancel` | Allowed until the order is packed. Restores stock; a paid order gets a refund. |
| POST | `/orders/:id/return` | `{ reason }` within the return window after delivery. |
| POST | `/orders/track` | Guest tracking by `{ orderNumber, email }`. |
| POST | `/payments/razorpay/webhook` | Signed with `RAZORPAY_WEBHOOK_SECRET` (`X-Razorpay-Signature` over the raw body). Handles `payment.authorized`, `payment.captured`, `payment.failed`, `order.paid`, `refund.processed`, `refund.failed`. Duplicate events are acknowledged and ignored. Returns `401` for a bad signature and `503` when Razorpay is not configured. |

### Order lifecycle

Order statuses: `PENDING`, `CONFIRMED`, `PAYMENT_PENDING`, `PAYMENT_FAILED`, `PAID`,
`PROCESSING`, `PACKED`, `SHIPPED`, `OUT_FOR_DELIVERY`, `DELIVERED`, `CANCELLED`,
`RETURN_REQUESTED`, `RETURNED`, `REFUND_PENDING`, `REFUNDED`.

Payment statuses: `UNPAID`, `PENDING`, `PAID`, `FAILED`, `REFUND_PENDING`,
`PARTIALLY_REFUNDED`, `REFUNDED`.

Admins can make these moves by hand; anything else answers `409 INVALID_TRANSITION`:

| From | To |
| ---- | -- |
| `PENDING` | `PROCESSING`, `CANCELLED` |
| `CONFIRMED` (COD) | `PROCESSING`, `PACKED`, `CANCELLED` |
| `PAYMENT_PENDING`, `PAYMENT_FAILED` | `CANCELLED` |
| `PAID` | `PROCESSING`, `CANCELLED` |
| `PROCESSING` | `PACKED`, `CANCELLED` |
| `PACKED` | `SHIPPED` (tracking number required), `CANCELLED` |
| `SHIPPED` | `OUT_FOR_DELIVERY`, `DELIVERED`, `RETURNED` |
| `OUT_FOR_DELIVERY` | `DELIVERED`, `RETURNED` |
| `DELIVERED` | `RETURN_REQUESTED` |
| `RETURN_REQUESTED` | `RETURNED`, `DELIVERED` (return declined) |

`PAID`, `PAYMENT_*`, `REFUND_PENDING` and `REFUNDED` are set only by verified payment events
and the refund workflow. A COD order becomes paid when it is marked `DELIVERED`. Online orders
that stay unpaid are cancelled by the 10-minute cron after the gateway has been checked once
more.

## Admin

Every route below is under `/admin` and needs an admin token plus the permission shown. Writes
are audit-logged. Content, SEO and settings writes purge the storefront's `content` cache tag;
product, inventory and order writes purge `catalog`.

| Area | Routes | Permission |
| ---- | ------ | ---------- |
| Auth | `POST /auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/change-password`; `GET /auth/me` | none for login |
| Dashboard | `GET /dashboard?days=30&currency=INR` (or `from`/`to`; money figures are per currency, never added across), `GET /dashboard/order-stats` | `dashboard.view` |
| Reports | `GET /reports?type=sales\|products\|payments\|customers&days=30`, `GET /reports/export?type=…` (CSV). Rows carry `currency`; customer rows split spend into `spentInr` and `spentUsd`. | `reports.view`, `reports.export` |
| Products | `GET/POST /products` (`pricing=missing-usd` lists products with no USD price; `meta.counts.missingUsd`), `GET/PUT/PATCH/DELETE /products/:id`, `PATCH /products/:id/status`, `PATCH /products/:id/merchandising`, `POST /products/merchandising/reorder`. `price` (₹) and `priceUsd` ($) are both required on create; on update an omitted `priceUsd` keeps the stored one. Variants may override either; `null` follows the product. | `products.*` |
| Inventory | `GET /inventory?stock=in\|low\|out`, `GET /inventory/movements`, `POST /products/:id/inventory`, `GET /products/:id/inventory-log` | `inventory.view`, `inventory.adjust` |
| Taxonomy | `/taxonomy/categories[/:id]`, `/taxonomy/:kind[/:id]` | `categories.*`, `taxonomy.*` |
| Collections | `GET/POST /collections`, `GET/PUT/DELETE /collections/:id` | `collections.*` |
| Banners | `GET/POST /content/banners`, `PATCH/DELETE /content/banners/:id` (image or video, schedule, placement) | `banners.*` |
| Homepage | `GET /content/homepage-sections`, `PATCH /content/homepage-sections/:id`, `POST /content/homepage-sections/reorder` | `content.view`, `content.update` |
| Pages | `GET/POST /content/pages`, `GET/PUT/DELETE /content/pages/:id` | `content.*` |
| Settings | `GET/PUT /content/settings` (store details, announcement bar, India shipping fees and free-shipping threshold, international `commerce.usd.*` fees and threshold, COD limit, return and payment windows, SEO defaults, social links) | `settings.view`, `settings.update` |
| SEO | `GET/PUT /seo`, `DELETE /seo/:id`, `GET /seo/audit`, `GET/POST /seo/redirects`, `PATCH/DELETE /seo/redirects/:id` | `seo.view`, `seo.update` |
| Media | `GET/POST /media` (multipart upload to R2), `PATCH/DELETE /media/:id` | `media.*` |
| Orders | `GET /orders` (`q`, `status`, `paymentStatus`, `currency`, dates), `GET /orders/export/csv`, `GET /orders/:id`, `PATCH /orders/:id/status` (`{ status, note?, carrier?, trackingNumber?, trackingUrl? }`), `PATCH /orders/:id`, `POST /orders/:id/refund` (`{ amount?, reason }`), `POST /orders/:id/payments/sync` | `orders.*`, `refunds.create`, `payments.sync` |
| Payments | `GET /payments` (`currency` filter), `GET /payments/export/csv`, `GET /payments/events` (webhook log) | `payments.view`, `payments.export` |
| Refunds | `GET /payments/refunds/all`, `POST /payments/refunds/:id/approve`, `POST /payments/refunds/:id/reject` | `refunds.*` |
| Coupons | `GET/POST /coupons`, `PATCH/DELETE /coupons/:id` | `discounts.*` |
| Customers | `GET /customers` (`q`, `status`, `sort`), `GET /customers/export/csv`, `GET /customers/:id`, `POST /customers/:id/block`, `DELETE /customers/:id` | `customers.*` |
| Login activity | `GET /login-activity` (`q` by email, `event`, `kind` = `CUSTOMER`/`ADMIN`, `userId`, `from`, `to`) | `customers.activity` |
| Enquiries | `GET /contact`, `PATCH /contact/:id`, `GET /newsletter`, `GET /newsletter/export/csv` | `contact.*`, `newsletter.*` |
| Admins | `GET/POST /admins`, `PATCH/DELETE /admins/:id`, `GET /roles`, `GET /audit` | `admins.*`, `roles.view`, `audit.view` |

`/admin/reviews`, `/admin/notifications` and `/admin/blog` answer `501`.

### Refunds

`POST /admin/orders/:id/refund` creates a refund request (`REFUND_PENDING`). Approving it
calls the Razorpay refund API for online payments; the order becomes `REFUNDED` when
Razorpay confirms (`refund.processed` webhook or payment sync). COD refunds are recorded as
`manual` and complete on approval. Approving twice answers `409`.
