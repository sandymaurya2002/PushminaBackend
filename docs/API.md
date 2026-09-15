# Pushmina API Reference

Base URL: `http://localhost:5000/api/v1`

234 endpoints — 85 public/customer, 149 admin.
Regenerate the complete list at any time:

```bash
npx tsx scripts/list-routes.ts --full
```

---

## Conventions

### Response envelope

Every response uses the same shape, so the storefront and the admin panel each
need exactly one response handler.

**Success**

```json
{ "success": true, "data": { ... }, "meta": { ... } }
```

**Paginated**

```json
{
  "success": true,
  "data": [ ... ],
  "meta": {
    "page": 1, "limit": 24, "total": 30,
    "totalPages": 2, "hasNext": true, "hasPrev": false
  }
}
```

**Failure**

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Please check the highlighted fields.",
    "details": { "email": "Please enter a valid email address." }
  }
}
```

`details` is keyed by field path, so it binds directly to form errors.

### Status codes

| Code | Meaning |
|---|---|
| 200 / 201 / 204 | Success |
| 400 | Malformed request |
| 401 | Not signed in, or token expired |
| 402 | Payment failed |
| 403 | Signed in, but not permitted |
| 404 | Not found |
| 409 | Conflict — duplicate, or still referenced |
| 422 | Validation failed (see `details`) |
| 429 | Rate limited |
| 503 | Database unavailable |

### Authentication

Two separate token audiences. A customer token can never satisfy an admin
guard, even if forged with the correct secret.

```
Authorization: Bearer <accessToken>
```

Access tokens last 15 minutes. Refresh tokens are opaque, stored only as a
SHA-256 hash, single-use, and sent as an httpOnly cookie *and* in the body so a
future mobile client can use the same endpoints.

### Money

All amounts are **numbers in rupees** — `8999` means ₹8,999. Never strings.
Conversion to paise happens only inside the Razorpay adapter.

### Filter arrays

Comma-delimited or repeated, matching the storefront's own URL format:

```
?color=ivory,cream&material=pure-pashmina&sort=price-low
```

---

## Public — Catalogue

| Method | Path | Purpose |
|---|---|---|
| GET | `/taxonomy` | All filter options: colours (with hex), sizes, materials, patterns, categories, sort options |
| GET | `/colors` | Colours only |
| GET | `/categories` | Categories with product counts |
| GET | `/categories/:slug` | One category |
| GET | `/collections` | All collections. `?group=` `?featured=true` |
| GET | `/collections/:slug` | One collection with FAQs and related |
| GET | `/collections/:slug/products` | Collection page in one request — products, facets and the collection itself |
| GET | `/products` | Filtered, sorted, paginated listing with facets |
| GET | `/products/:slug` | Full product detail |
| GET | `/products/:slug/related` | Related products |
| GET | `/products/batch?slugs=a,b,c` | Resolve slugs in order — backs recently-viewed and guest wishlist |
| GET | `/products/trending` | Admin-curated trending rail |
| GET | `/products/featured` | Admin-curated featured rail |
| GET | `/products/new-arrivals` | Admin-curated new arrivals |
| GET | `/products/best-sellers` | Ranked by popularity |
| GET | `/search?q=` | Instant search — products + matching collections |

### `GET /products` — query parameters

| Parameter | Type | Notes |
|---|---|---|
| `category` `color` `material` `size` `pattern` `collection` | csv | Filter facets |
| `availability` | csv | `in-stock`, `out-of-stock` |
| `minPrice` `maxPrice` | number | Rupees |
| `sort` | enum | `featured` `newest` `price-low` `price-high` `best-selling` |
| `q` | string | Full-text search |
| `page` `limit` | number | Default 1 / 24, max 100 |
| `facets` | boolean | Set `false` to skip facet computation |

Facet counts are computed against the **collection scope**, not the filtered
result, so counts never collapse to zero as a customer narrows down.

---

## Public — Content

| Method | Path | Purpose |
|---|---|---|
| GET | `/content/homepage` | Whole homepage in one request — ordered sections, banners by placement, and all four product rails |
| GET | `/content/settings` | Site name, contact, social, announcements, commerce rules |
| GET | `/content/navigation` | Header mega menu + footer columns |
| GET | `/content/banners?placement=` | Banners, respecting schedule windows |
| GET | `/content/pages/:slug` | About, craftsmanship, contact, shipping, returns, privacy, terms, faqs |
| GET | `/content/landing` | Landing page index |
| GET | `/content/landing/:slug` | One landing page |
| POST | `/content/contact` | Contact form submission |
| POST | `/content/newsletter/subscribe` | Newsletter sign-up |
| GET | `/content/newsletter/unsubscribe?token=` | One-click unsubscribe |

## Public — Journal

| Method | Path |
|---|---|
| GET | `/blog?category=&tag=&q=&page=&limit=` |
| GET | `/blog/categories` |
| GET | `/blog/:slug` — post with related products, collections and articles |

## Public — SEO

| Method | Path | Purpose |
|---|---|---|
| GET | `/seo/resolve?type=&slug=` | Metadata for one page. `type` = `home` `product` `collection` `post` `page` `landing` |
| GET | `/seo/sitemap` | Every indexable URL with lastModified and priority |
| GET | `/seo/redirects` | Active redirects |

## Public — Reviews

| Method | Path |
|---|---|
| GET | `/reviews/product/:slug?sort=newest\|highest\|lowest` |
| POST | `/reviews` — held for moderation |
| GET | `/reviews/mine` — auth required |

---

## Customer — Authentication

| Method | Path |
|---|---|
| POST | `/auth/register` |
| POST | `/auth/login` |
| POST | `/auth/refresh` |
| POST | `/auth/logout` |
| POST | `/auth/logout-all` |
| POST | `/auth/forgot-password` |
| POST | `/auth/reset-password` |
| POST | `/auth/change-password` |
| GET · PATCH | `/auth/me` |
| GET · POST | `/auth/addresses` |
| PATCH · DELETE | `/auth/addresses/:id` |
| POST | `/auth/addresses/:id/default` |

`forgot-password` always reports success, whether or not the address exists —
confirming which emails have accounts is a free gift to an attacker.

## Customer — Cart

Works signed-out. A guest cart is keyed to an httpOnly cookie and is carried
onto the account automatically at sign-in.

| Method | Path |
|---|---|
| GET | `/cart` |
| POST | `/cart/items` — `{ variantId, quantity }` |
| PATCH | `/cart/items/:itemId` — `{ quantity }` (0 removes) |
| DELETE | `/cart/items/:itemId` |
| DELETE | `/cart` |
| POST · DELETE | `/cart/coupon` |
| GET | `/cart/validate` — pre-checkout stock check |

Prices are **always re-read from the database**. A tampered request body cannot
change what something costs.

## Customer — Wishlist

| Method | Path |
|---|---|
| GET | `/wishlist` · `/wishlist/slugs` |
| POST | `/wishlist/toggle` · `/wishlist/merge` |
| DELETE | `/wishlist/:slug` · `/wishlist` |

## Customer — Orders

| Method | Path |
|---|---|
| POST | `/orders` — checkout. Works signed-out |
| GET | `/orders?status=&page=` |
| GET | `/orders/:id` |
| POST | `/orders/:id/cancel` |
| POST | `/orders/track` — `{ orderNumber, email }`, no auth |

## Customer — Payments

| Method | Path | Notes |
|---|---|---|
| POST | `/payments/initiate` | Send `X-Idempotency-Key` so a retry cannot double-charge |
| POST | `/payments/verify` | Signature verified server-side; amount re-checked |
| POST | `/payments/webhook` | Gateway only. Signature over the raw body |
| GET | `/payments/history` |
| GET | `/payments/:id` |
| POST | `/payments/refund-request` |
| POST | `/payments/mock/sign` | **Local development only** — produces the signature a real gateway would return |

### Checkout sequence

```
POST /orders                          → order (PENDING), stock reserved
POST /payments/initiate               → providerOrderId + publicKey
  ── open the gateway widget in the browser ──
POST /payments/verify                 → CAPTURED, order → CONFIRMED
```

The webhook settles the same payment independently. Both paths funnel through
one function, so they can never disagree, and a replayed webhook is a no-op.

## Customer — Notifications

| Method | Path |
|---|---|
| GET | `/notifications?unreadOnly=` |
| GET | `/notifications/unread-count` |
| POST | `/notifications/:id/read` · `/notifications/read-all` |
| DELETE | `/notifications/:id` |
| GET · PUT | `/notifications/preferences` |

---

## Admin

All admin routes require `Authorization: Bearer <adminAccessToken>` and declare
a specific permission. Super Admin bypasses permission checks by design.

### Authentication

| Method | Path |
|---|---|
| POST | `/admin/auth/login` |
| POST | `/admin/auth/refresh` · `/admin/auth/logout` |
| GET | `/admin/auth/me` |
| POST | `/admin/auth/change-password` |

### Dashboard

| Method | Path | Permission |
|---|---|---|
| GET | `/admin/dashboard?days=30` | `dashboard.view` |
| GET | `/admin/dashboard/order-stats` | `orders.view` |

Returns totals, revenue (gross, refunded and **net**), payment breakdown, stock
alerts, a daily revenue series, recent orders, recent notifications, trending
products and best sellers.

### Products

| Method | Path | Permission |
|---|---|---|
| GET | `/admin/products` | `products.view` |
| GET | `/admin/products/:id` | `products.view` |
| POST | `/admin/products` | `products.create` |
| PUT | `/admin/products/:id` | `products.update` |
| PATCH | `/admin/products/:id/status` | `products.publish` |
| PATCH | `/admin/products/:id/merchandising` | `products.merchandise` |
| POST | `/admin/products/merchandising/reorder` | `products.merchandise` |
| POST | `/admin/products/variants/:variantId/inventory` | `inventory.adjust` |
| GET | `/admin/products/variants/:variantId/inventory-log` | `inventory.view` |
| DELETE | `/admin/products/:id` | `products.delete` |

Filters: `q` `status` `categoryId` `materialId` `stock` (`in`/`low`/`out`)
`flag` (`featured`/`trending`/`new`) `sort`.

A product that appears in any order cannot be deleted — archive it instead.

### Taxonomy — the storefront's filter vocabulary

Colours, sizes, materials and patterns each support the same five operations.

| Method | Path |
|---|---|
| GET | `/admin/taxonomy/{colors\|sizes\|materials\|patterns}` |
| GET | `.../:id` |
| POST | `.../` |
| PATCH | `.../:id` |
| DELETE | `.../:id` |
| POST | `.../reorder` — `{ ids: [...] }` |

Categories live at `/admin/taxonomy/categories` with the same verbs.

A term still used by products cannot be deleted — deactivate it instead, which
removes it from the filters without touching any product.

### Collections & content

| Method | Path |
|---|---|
| GET · POST | `/admin/content/collections` |
| GET · PUT · DELETE | `/admin/content/collections/:id` |
| GET · POST | `/admin/content/banners` |
| PATCH · DELETE | `/admin/content/banners/:id` |
| GET | `/admin/content/homepage-sections` |
| PATCH | `/admin/content/homepage-sections/:id` |
| POST | `/admin/content/homepage-sections/reorder` |
| GET · POST | `/admin/content/pages` |
| GET · PUT · DELETE | `/admin/content/pages/:id` |
| GET · POST | `/admin/content/landing-pages` |
| GET · PUT · DELETE | `/admin/content/landing-pages/:id` |
| GET · POST | `/admin/content/navigation` |
| PATCH · DELETE | `/admin/content/navigation/:id` |
| POST | `/admin/content/navigation/reorder` |
| GET · PUT | `/admin/content/settings` |

### Orders

| Method | Path | Permission |
|---|---|---|
| GET | `/admin/orders` | `orders.view` |
| GET | `/admin/orders/:id` | `orders.view` |
| PATCH | `/admin/orders/:id/status` | `orders.update` |
| PATCH | `/admin/orders/:id/fulfilment` | `orders.fulfil` |
| GET | `/admin/orders/export/csv` | `orders.export` |

Filters: `q` `status` `paymentStatus` `from` `to` `sort`.
Status changes are validated against the transition table and notify the
customer automatically.

### Payments & refunds

| Method | Path | Permission |
|---|---|---|
| GET | `/admin/payments` | `payments.view` |
| GET | `/admin/payments/:id` | `payments.view` |
| GET | `/admin/payments/webhooks/events` | `payments.view` |
| GET | `/admin/payments/export/csv` | `payments.export` |
| GET | `/admin/payments/refunds/all` | `refunds.view` |
| POST | `/admin/payments/refunds` | `refunds.create` |
| POST | `/admin/payments/refunds/:id/approve` | `refunds.approve` |
| POST | `/admin/payments/refunds/:id/reject` | `refunds.reject` |

Search matches transaction id, gateway order id, order number or customer email.
No money moves until a refund is **approved**.

### Customers

| Method | Path | Permission |
|---|---|---|
| GET | `/admin/customers` | `customers.view` |
| GET | `/admin/customers/:id` | `customers.view` |
| PATCH | `/admin/customers/:id` | `customers.update` |
| POST | `/admin/customers/:id/block` | `customers.block` |
| DELETE | `/admin/customers/:id` | `customers.delete` |
| GET | `/admin/customers/export/csv` | `customers.export` |

Blocking revokes every session immediately. A customer with orders is
**anonymised** rather than deleted, so order history and revenue reports stay
intact.

### Journal

| Method | Path |
|---|---|
| GET · POST | `/admin/blog/posts` |
| GET · PUT · DELETE | `/admin/blog/posts/:id` |
| PATCH | `/admin/blog/posts/:id/status` |
| GET · POST | `/admin/blog/categories` |
| PATCH · DELETE | `/admin/blog/categories/:id` |
| GET · POST · PATCH · DELETE | `/admin/blog/tags` |

Article bodies are **typed blocks**, never raw HTML. Setting status to
`SCHEDULED` with a future `scheduledAt` publishes automatically.

### SEO

| Method | Path |
|---|---|
| GET | `/admin/seo` |
| PUT | `/admin/seo` — upsert by `(entityType, entityId)` |
| DELETE | `/admin/seo/:id` |
| POST | `/admin/seo/preview` |
| GET | `/admin/seo/audit` — health check |
| GET · POST | `/admin/seo/redirects` |
| DELETE | `/admin/seo/redirects/:id` |

### Media, reviews, enquiries, newsletter, discounts

| Method | Path |
|---|---|
| GET · POST | `/admin/media` (multipart `files`, `folder`, `alt`) |
| PATCH · DELETE | `/admin/media/:id` |
| GET | `/admin/reviews?status=` |
| PATCH · DELETE | `/admin/reviews/:id` |
| GET | `/admin/contact?status=` |
| PATCH · DELETE | `/admin/contact/:id` |
| GET | `/admin/newsletter` · `/admin/newsletter/export/csv` |
| DELETE | `/admin/newsletter/:id` |
| GET · POST | `/admin/coupons` |
| PATCH · DELETE | `/admin/coupons/:id` |

### Notifications, admins, roles, audit

| Method | Path | Permission |
|---|---|---|
| GET | `/admin/notifications` | `notifications.view` |
| POST | `/admin/notifications/broadcast` | `notifications.send` |
| GET · POST | `/admin/admins` | `admins.view` / `admins.create` |
| PATCH · DELETE | `/admin/admins/:id` | `admins.update` / `admins.delete` |
| GET | `/admin/roles` | `roles.view` |
| PUT | `/admin/roles/:id/permissions` | Super Admin only |
| GET | `/admin/audit` | `audit.view` |

You cannot change your own role, deactivate yourself, or remove the last active
Super Admin.

---

## Roles

| Role | Access |
|---|---|
| Super Admin | Everything, including admins and roles |
| Admin | All store operations; not admins or roles |
| Store Manager | Catalogue, orders, payments, customers; no settings or SEO |
| Content Editor | Blog, pages, banners, navigation, SEO, media |
| Customer Support | Read orders and customers; handle enquiries and refund requests |

85 permissions across 24 groups. Full list: `src/config/permissions.ts`.

---

## Rate limits

| Scope | Limit |
|---|---|
| All API | 600 per 15 min |
| Login / register / password reset | 20 per 15 min (successful requests not counted) |
| Payments | 20 per min |
| Public writes (contact, newsletter, reviews) | 30 per hour |
| Search | 240 per min |
| Uploads | 60 per min |

---

## Worked example — complete checkout

```bash
API=http://localhost:5000/api/v1

# 1. Register
TOKEN=$(curl -s -X POST $API/auth/register -H 'Content-Type: application/json' \
  -d '{"firstName":"Test","lastName":"Buyer","email":"buyer@test.com","password":"Test1234"}' \
  | jq -r .data.tokens.accessToken)

# 2. Pick an in-stock variant
VID=$(curl -s "$API/products/ivory-heritage-pashmina-shawl" \
  | jq -r '.data.variants[] | select(.inventory > 0) | .id' | head -1)

# 3. Add to bag
curl -s -X POST $API/cart/items -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d "{\"variantId\":\"$VID\",\"quantity\":1}"

# 4. Apply a discount
curl -s -X POST $API/cart/coupon -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"code":"HERITAGE10"}'

# 5. Place the order
OID=$(curl -s -X POST $API/orders -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{
    "address":{"fullName":"Test Buyer","email":"buyer@test.com","phone":"9810000000",
               "line1":"14 Rani Jhansi Marg","city":"New Delhi","state":"Delhi","postalCode":"110054"},
    "shippingMethod":"standard","paymentMethod":"UPI"}' | jq -r .data.id)

# 6. Start payment
POID=$(curl -s -X POST $API/payments/initiate -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H 'X-Idempotency-Key: demo-001' \
  -d "{\"orderId\":\"$OID\",\"method\":\"UPI\"}" | jq -r .data.providerOrderId)

# 7. Sign (local mock only — a real gateway does this)
SIG=$(curl -s -X POST $API/payments/mock/sign -H 'Content-Type: application/json' \
  -d "{\"providerOrderId\":\"$POID\",\"providerPaymentId\":\"pay_demo\"}" | jq -r .data.signature)

# 8. Verify → CAPTURED, order → CONFIRMED
curl -s -X POST $API/payments/verify -H 'Content-Type: application/json' \
  -d "{\"providerOrderId\":\"$POID\",\"providerPaymentId\":\"pay_demo\",\"signature\":\"$SIG\"}"
```
