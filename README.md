# Pashmore Backend

| Folder    | What it is                                                                                   | Deploys to                          |
| --------- | -------------------------------------------------------------------------------------------- | ----------------------------------- |
| `worker/` | The commerce API: Hono on Cloudflare Workers, D1 `pashmore-db`, private R2 `pashmore-media`. | Worker `pashmore-api`               |
| `admin/`  | React/Vite admin dashboard.                                                                  | Cloudflare Pages `pashmore-admin`   |
| `src/`    | Optional stateless Node gateway that forwards `/api`, `/media` and `/health` to the Worker.  | Render or Azure (only if still used) |

The gateway has no database, sessions or business rules. Authentication, CORS, rate limiting and
cookies are all handled by the Worker. `prisma/` holds the retired PostgreSQL schema and
`seed-data.json` for reference only; nothing at runtime uses them.

The full API reference is [docs/WORKER-API.md](docs/WORKER-API.md). (`docs/API.md` describes
the retired Node API.)

## Running everything locally

Three processes: the Worker (API, local D1 and R2), the admin dashboard and the storefront
(`D:\Pashmore`). Node 22 is required (the content seed imports TypeScript directly).

**1. Worker** (`http://127.0.0.1:8787`)

```bash
cd worker
npm install
cp .dev.vars.example .dev.vars          # then fill in the secrets, see below
npm run db:migrate:local                # applies 0001–0005 to the local D1
node scripts/seed-catalog.mjs --local   # products, collections, stock (once)
node scripts/seed-content.mjs --local   # shipping/returns/privacy/terms pages (once)
node scripts/bootstrap-admin.mjs --local --email you@example.com --name "Your Name"
npm run dev
```

`bootstrap-admin.mjs` prints a generated password once (or uses `ADMIN_BOOTSTRAP_PASSWORD`).
Check `http://127.0.0.1:8787/health`: it reports the schema, the enabled checkout methods and
whether email is configured.

**2. Admin dashboard** (`http://localhost:5173`)

```bash
cd admin
npm install
npm run dev     # Vite proxies /api and /media to the Worker on :8787; no env needed
```

**3. Storefront** (`http://localhost:3000`, or any free port)

```bash
cd D:\Pashmore
npm ci
cp .env.example .env.local   # see the storefront variables below
npm run dev                  # or: npx next dev -p 3100 if port 3000 is taken
```

If the storefront runs on a port other than 3000, set the same origin in the Worker's
`FRONTEND_ORIGIN` and `STOREFRONT_URL` and in the storefront's `NEXT_PUBLIC_SITE_URL`, then
restart both.

Minimum storefront `.env.local` for local development:

| Variable | Local value |
| -------- | ----------- |
| `NEXT_PUBLIC_SITE_URL` | `http://localhost:3000` (the storefront's own origin) |
| `CLOUDFLARE_API_URL` | `http://127.0.0.1:8787` |
| `CLOUDFLARE_R2_PUBLIC_URL` | `https://media.pashmore.com` |
| `IMAGE_REMOTE_HOSTS` | `www.pashmore.com` (the seeded product images live there) |
| `CLOUDFLARE_GATEWAY_SECRET` | Same random value as the Worker's `GATEWAY_SECRET` |
| `REVALIDATE_SECRET` | Same random value as the Worker's `REVALIDATE_SECRET` |

Generate random secrets with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
Never commit `.dev.vars` or `.env.local` (both are git-ignored).

### Tests

```bash
cd worker && npm run typecheck && npm test   # Worker: Vitest in the Workers runtime
cd D:\Pashmore && npm run typecheck && npm run lint && npm test && npm run build
cd admin && npm run build
```

### End-to-end check

With all three processes running, `worker/scripts/e2e-local.mjs` walks the main flows through
the storefront's own `/api` routes and the admin API. It covers:

- banners, the announcement bar and redirects reaching the site;
- registration, sign-in, sign-out and login activity;
- search, server-priced cart and stock enforcement;
- COD checkout with an idempotent retry;
- webhook signature checks, and a forged payment verification that is rejected;
- the order status lifecycle, tracking, return, refund and cancellation;
- dashboard, reports and CSV export.

```powershell
cd worker
$env:ADMIN_EMAIL="you@example.com"; $env:ADMIN_PASSWORD="..."
$env:STOREFRONT_URL="http://localhost:3000"   # defaults to http://localhost:3100
node scripts/e2e-local.mjs
```

It refuses to run against anything but localhost. It creates a throwaway customer and orders
in the local database and removes the banner, announcement and redirect it added.

`worker/scripts/e2e-currency.mjs` (same variables) covers INR/USD pricing:

- a product needs both prices;
- each price can be changed on its own;
- ₹ is shown in India and $ elsewhere;
- guest and signed-in bags, and checkout, enforce the delivery-country rule;
- the Razorpay order is created in USD;
- placed orders keep their price after later edits;
- order history shows each order in its own currency;
- admin currency filters work.

It archives its test product afterwards.

### Testing payments in Razorpay sandbox

Online payment appears at checkout only when both Razorpay keys are set. Use **Test Mode**
keys (`rzp_test_…`), which never move real money:

1. In the Razorpay Dashboard (Test Mode), copy the Key ID and Secret into `.dev.vars` as
   `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`.
2. Add a webhook pointing at `<public-worker-url>/api/v1/payments/razorpay/webhook` with
   the events `payment.authorized`, `payment.captured`, `payment.failed`, `order.paid`,
   `refund.processed` and `refund.failed`. Put the secret you choose in
   `RAZORPAY_WEBHOOK_SECRET`. Razorpay cannot reach `localhost`, so expose the Worker with a
   tunnel (for example `cloudflared tunnel --url http://127.0.0.1:8787`) or test webhooks on
   a staging deployment. Without webhooks, the payment is still confirmed by the server-side
   signature check plus a fetch from Razorpay.
3. Restart `npm run dev`, place an order on the storefront and pay with a Razorpay
   [test card or UPI ID](https://razorpay.com/docs/payments/payments/test-card-details/).
4. Refund from the admin: order, then **Refund**, then approve it under **Refunds**. Razorpay
   only refunds what the account balance can cover. A new Test Mode account starts at ₹0, and
   captured test payments count only once they settle. Until then Razorpay declines the refund,
   the admin sees "the account balance most likely cannot cover it yet", and the refund stays
   *Failed* so it can be approved again later.

An order is marked paid only after the Worker verifies the payment. It never trusts the
browser's word: it checks the HMAC signature, fetches the payment from Razorpay, or receives
a signed webhook.

International (USD) orders are sent to Razorpay in US dollars. Live USD payments need
**International Payments** enabled on the Razorpay account (Dashboard → Account & Settings).
Until it is, Razorpay rejects USD orders and international shoppers cannot pay online.

### Prices in INR and USD

Customers in India see and pay ₹ INR; everyone else sees and pays $ USD. The admin enters
both prices on each product (and, optionally, per variant); nothing is converted.

- **Region.** The storefront detects the visitor's country from the host's geolocation header:
  `x-vercel-ip-country`, `cf-ipcountry` or `cloudfront-viewer-country`. A country selector in
  the header and mobile menu overrides it and is remembered in the `pm_country` cookie. The
  storefront sends the result to the Worker as `X-Client-Country` (or `?currency=` on
  catalogue reads). An unknown country is treated as India.
- **Enforcement.** The Worker prices every bag and order itself. An order's currency comes
  from its delivery country, so a USD bag cannot be shipped to India or the reverse
  (`REGION_MISMATCH`); checkout offers a one-click switch. Cash on delivery is India-only.
- **Missing USD prices.** Products without a USD price are not sold outside India. In the
  admin, **Products → Pricing → Missing USD price** lists them. Every product that existed
  before migration 0004 starts in that list.
- **International shipping** is set under **Settings → International shipping (USD)**:
  free above $250, standard $25, express $45 by default.
- **Coupons.** Coupon minimums and caps are in rupees, so outside India only plain percentage
  codes apply.
- **Reporting.** Dashboard, reports, payments and customer spend are shown per currency and
  never added across currencies.

### Worker configuration

Plain settings live in `wrangler.jsonc` `vars`. Secrets are set with
`npx wrangler secret put NAME` in production, or in `.dev.vars` locally.

| Variable | Purpose |
| -------- | ------- |
| `FRONTEND_ORIGIN` | Comma-separated storefront origins allowed by CORS. |
| `ADMIN_ORIGIN` | Comma-separated admin origins (the only origins allowed on `/admin`). |
| `STOREFRONT_URL` | Storefront base URL used in emails and to purge its cache. |
| `ENABLE_COD_ORDERS` | `"true"` enables cash on delivery. Default off. |
| `ACCESS_TOKEN_TTL_SECONDS` | Access token lifetime (default 900). |
| `REFRESH_TOKEN_TTL_SECONDS` | Customer session lifetime (default 30 days). |
| `ADMIN_REFRESH_TOKEN_TTL_SECONDS` | Admin session lifetime (default 12 hours). |
| `MEDIA_PUBLIC_BASE_URL` | Optional absolute base for `/media` URLs; defaults to the request host. |
| `MAIL_FROM` | Sender for transactional email. |
| `GATEWAY_SECRET` (secret) | Lets the storefront (or Node gateway) forward the shopper's IP for rate limiting. Must equal the storefront's `CLOUDFLARE_GATEWAY_SECRET`. |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` (secrets) | Razorpay API keys. Online payment is offered only when both are set. |
| `RAZORPAY_WEBHOOK_SECRET` (secret) | Webhook signing secret. Webhooks answer `503` without it. |
| `RESEND_API_KEY` (secret) | Order, status and password-reset emails through Resend. Without it emails are skipped. |
| `REVALIDATE_SECRET` (secret) | Must equal the storefront's `REVALIDATE_SECRET`, so admin edits appear on the site at once instead of within 5 minutes. |
| `EMAIL_DEV_LOG` | `"true"` prints emails (including reset links) to the console. Local development only. |
| `RAZORPAY_API_BASE` | Tests only. |

Cron triggers: daily housekeeping at 03:17 UTC, and every 10 minutes to cancel online orders
whose payment window lapsed (after one last check with Razorpay).

### Deploying

Nothing here runs automatically. Take a D1 backup first
(`npx wrangler d1 export pashmore-db --remote --output backup.sql`).

```bash
cd worker
npx wrangler login
node scripts/check-remote-schema.mjs           # read-only drift check against live D1
npx wrangler d1 migrations apply DB --remote   # applies only migrations not yet run
node scripts/seed-content.mjs                  # copies the policy pages to live D1; never overwrites existing ones
npx wrangler secret put REVALIDATE_SECRET      # and the Razorpay/Resend secrets when ready
npx wrangler deploy
node scripts/bootstrap-admin.mjs --email you@example.com --name "Your Name"   # first deploy only
```

Migration `0003_storefront_operations.sql` adds the payments, refunds, content, SEO, login
activity, coupon and enquiry tables. It also rebuilds `orders`, because SQLite cannot widen
the status `CHECK` constraint in place. Every order row is copied, and order items and status
history are backed up and restored within the migration. It has been applied and tested
against the local database only, not the live one.

Migration `0004_dual_currency_pricing.sql` is additive. It adds `price_usd_cents` and
`compare_at_price_usd_cents` to products and variants, and `currency` (default `INR`) and
`pricing_country` to orders. No existing row is rewritten: products keep their INR price, and
every existing order becomes an INR order. Apply it **before** deploying the new Worker,
because the Worker answers `503 schema_mismatch` until the columns exist. Then deploy the
storefront. Locally it was applied to the database with 30 products, 83 variants and 7 orders,
and counts, prices and order totals were unchanged afterwards. It has not been run against
the live database.

Use live Razorpay keys only after a full sandbox payment and refund test has passed.

`bootstrap-admin.mjs` takes the password from `ADMIN_BOOTSTRAP_PASSWORD`, or generates one and prints it
once. It refuses to modify an existing account.

`node scripts/seed-catalog.mjs [--local]` imports `prisma/seed-data.json` (taxonomy, categories,
collections, products, variants, stock). It refuses to run when the catalogue already has rows, and
stores images as absolute URLs on `--image-base` (default `https://www.pashmore.com`).

## Admin dashboard

```bash
cd admin
npm install
npm run dev     # Vite proxies /api and /media to wrangler dev on :8787
```

Production build and deploy:

```bash
cd admin
$env:VITE_API_BASE_URL="https://pashmore-api.sandymaurya2002.workers.dev"   # PowerShell
npm run build
npx wrangler pages deploy dist --project-name pashmore-admin --branch main
```

| Variable              | Purpose                                                     |
| --------------------- | ----------------------------------------------------------- |
| `VITE_API_BASE_URL`   | Worker origin. Empty in development (uses the Vite proxy). |
| `VITE_STOREFRONT_URL` | "View store" links. Defaults to `https://www.pashmore.com`. |

## Node gateway (optional)

```bash
npm install
cp .env.example .env    # set WORKER_API_URL and GATEWAY_SECRET
npm run dev
npm test
```

`GATEWAY_SECRET` must match the Worker secret of the same name and be at least 32 characters. The
gateway strips any client-supplied `X-Gateway-Secret`, `X-Client-IP` and `X-Forwarded-*` headers before
forwarding. Its own health check is `/gateway/health`; `/health` is the Worker's.

## Not yet implemented

Product reviews, the blog/journal editor and admin notifications (`/admin/reviews`,
`/admin/blog` and `/admin/notifications` answer `501`, and the dashboard hides them). Guest
checkout: customers sign in to place an order, while guest bags live in the storefront's
cookie and merge at sign-in.
