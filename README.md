# Pushmina Backend

E-commerce API, admin panel and CMS for [pushmina.com](http://localhost:3000).
Node.js · TypeScript · Express · PostgreSQL · Prisma · React admin.

Everything runs on your own machine. Nothing is deployed.

---

## What is here

```
D:\PushminaBackend\
├── prisma/
│   ├── schema.prisma        60 tables — catalogue, orders, payments, CMS, SEO, RBAC
│   ├── migrations/          version-controlled schema history
│   ├── seed.ts              loads the storefront's real catalogue into Postgres
│   └── seed-data.json       extracted from D:\Pushmina (read-only, never modified)
├── src/
│   ├── config/              env validation, logger, permission catalogue
│   ├── db/                  Prisma client singleton
│   ├── middleware/          auth, RBAC, validation, rate limiting, error handling
│   ├── modules/
│   │   ├── auth/            customer + admin authentication
│   │   ├── catalog/         products, categories, collections, taxonomy, search
│   │   ├── cart/            guest + account carts, coupons, totals
│   │   ├── wishlist/
│   │   ├── orders/          creation, status machine, stock reservation
│   │   ├── payments/        Razorpay + offline mock, webhooks, refunds
│   │   ├── notifications/   in-app + email, customer and admin
│   │   ├── email/           transactional templates
│   │   ├── blog/ content/   journal, pages, banners, navigation, settings
│   │   ├── seo/             metadata resolution, sitemap, redirects
│   │   ├── reviews/
│   │   ├── media/           uploads, resizing, thumbnails
│   │   └── admin/           all 23 admin sections
│   ├── jobs/                scheduled tasks
│   └── routes/              API v1 router
├── admin/                   React + Vite admin panel (separate app)
├── scripts/                 database creation, route listing, smoke test
└── uploads/                 admin-uploaded media (git-ignored)
```

**234 endpoints** — 85 public/customer, 149 admin.

---

## Requirements

| | |
|---|---|
| Node | 18.18+ (tested on 18.20.8) |
| PostgreSQL | 17 (installed locally) |
| npm | 10+ |

---

## Setup

### 1. PostgreSQL

Already installed? Check it is running:

```powershell
Get-Service postgresql-x64-17
```

If not installed:

```powershell
winget install -e --id PostgreSQL.PostgreSQL.17
```

Keep port **5432** and include **Command Line Tools**.

### 2. Configure

```bash
cd D:\PushminaBackend
copy .env.example .env
```

Edit `.env` and set your PostgreSQL password:

```env
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/pushmina_db?schema=public
```

> **Special characters must be percent-encoded.**
> `@` → `%40`, `:` → `%3A`, `/` → `%2F`, `#` → `%23`.
> A password of `Sandy@123` becomes `Sandy%40123`.

Generate real JWT secrets:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### 3. Install, migrate and seed

```bash
npm install
npm run db:setup      # creates the database, runs migrations, seeds
```

`db:setup` is equivalent to:

```bash
node scripts/create-database.mjs
npx prisma migrate dev --name init
npm run db:seed
```

The seed loads the storefront's actual content — 30 products, 83 variants,
32 collections, 8 journal articles, 9 landing pages, policy pages, the full
filter taxonomy and site settings.

### 4. Run

```bash
npm run dev            # API      → http://localhost:5000
npm run admin:dev      # Admin UI → http://localhost:5173
```

**Default credentials** (change immediately):

| | |
|---|---|
| Admin | `admin@pushmina.com` / `Admin@12345` |
| Demo customer | `ananya@example.com` / `Customer@12345` |

---

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | API with hot reload |
| `npm run build` / `start` | Production build and run |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:migrate` | Create and apply a migration |
| `npm run db:seed` | Re-seed (idempotent — safe to re-run) |
| `npm run db:reset` | **Drops all data**, re-migrates, re-seeds |
| `npm run db:studio` | Prisma Studio — browse the database |
| `npm run admin:dev` | Admin panel dev server |
| `npm run admin:build` | Admin production build |
| `npx tsx scripts/list-routes.ts --full` | Print every registered route |

---

## Design decisions worth knowing

**Money is `Decimal(12,2)` in rupees.** Prisma serialises Decimal to a JSON
*string*, which would make `compareAtPrice <= price` a lexicographic comparison
and break every discount calculation. `src/db/prisma.ts` teaches Decimal to
serialise as a number, once, globally. Conversion to paise happens only in the
Razorpay adapter.

**Stock is reserved at order creation, not at payment.** Otherwise two customers
could both reach the payment screen for the last shawl. Reservation uses a
conditional `updateMany` — a compare-and-set — so concurrent orders cannot
oversell. Abandoned checkouts release their stock automatically after 60 minutes.

**The frontend is never trusted about payments.** A browser reporting success is
a claim; only an HMAC computed with the gateway secret is evidence. Amounts are
re-checked against the order, signatures compared in constant time, and every
webhook recorded against a unique event id so replays are a no-op.

**Order status transitions are data, not `if` statements.** `ALLOWED_TRANSITIONS`
in `order.service.ts` makes an illegal jump impossible from any call site,
including the admin panel.

**Permissions are read from the database on every request**, not baked into the
token, so revoking a role takes effect immediately rather than when the access
token happens to expire.

**"Featured" sort is a denormalised column.** The storefront weights badges above
popularity, which spans a join table — and an `ORDER BY` over that cannot be
paginated correctly. `featuredScore` is recomputed whenever badges or popularity
change.

**Facet counts are computed against the collection scope**, not the filtered
result, so counts never collapse to zero as a customer narrows down — matching
the storefront's existing behaviour exactly.

**Products that have been ordered are archived, not deleted.** Deleting would
orphan order history and silently change every revenue report already run. The
same applies to customers (anonymised) and used coupons (deactivated).

---

## Payments

Razorpay, with an **offline mock** that activates automatically when
`RAZORPAY_KEY_ID` is empty. The mock implements the same interface and the same
signature arithmetic, so the whole order → payment → refund lifecycle is
testable on a laptop with no internet and no merchant account.

Going live:

```env
RAZORPAY_KEY_ID=rzp_live_xxxxx
RAZORPAY_KEY_SECRET=xxxxx
RAZORPAY_WEBHOOK_SECRET=xxxxx
```

The mock refuses to start when `NODE_ENV=production`.

Webhooks reach `POST /api/v1/payments/webhook`. Locally, a tunnel such as ngrok
is needed for the gateway to reach your machine — the browser-side verify call
covers the normal path without one.

---

## Email

With `SMTP_HOST` unset, emails are logged to the console and recorded in
`email_logs` instead of being sent, so notification flows are exercisable
offline. Set the SMTP variables to send for real.

---

## Security

- bcrypt (12 rounds) for passwords; refresh tokens stored only as SHA-256 hashes
- Refresh tokens are single-use and rotate, so a stolen one works at most once
- Rate limiting: 20 attempts per 15 min on credentials, 20/min on payments
- Helmet, CORS allow-list, `trust proxy` set to one hop so `X-Forwarded-For`
  cannot be spoofed to evade limits
- Zod validation on every request body, query and param
- Uploads restricted by MIME type, content-addressed filenames, path traversal
  blocked on delete
- Every admin mutation written to `audit_logs` with before/after state
- Blog content is typed blocks, never raw HTML — no stored-XSS surface

---

## Troubleshooting

**`Environment variable not found: DATABASE_URL`**
`.env` is missing. Copy `.env.example` to `.env`.

**`password authentication failed`**
Special characters in the password need percent-encoding. See step 2.

**`ECONNREFUSED 127.0.0.1:5432`**
PostgreSQL is not running: `net start postgresql-x64-17`

**`Unique constraint failed on the fields: (sku)`**
Two variants share a SKU. SKUs must be unique across the whole catalogue.

**Admin panel shows "Could not sign in"**
The API is not running. Start it with `npm run dev` in `D:\PushminaBackend`.

---

## API documentation

See [`docs/API.md`](docs/API.md).
