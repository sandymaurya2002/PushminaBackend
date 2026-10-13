# Pashmore Backend

| Folder    | What it is                                                                                   | Deploys to                          |
| --------- | -------------------------------------------------------------------------------------------- | ----------------------------------- |
| `worker/` | The commerce API: Hono on Cloudflare Workers, D1 `pashmore-db`, private R2 `pashmore-media`. | Worker `pashmore-api`               |
| `admin/`  | React/Vite admin dashboard.                                                                  | Cloudflare Pages `pashmore-admin`   |
| `src/`    | Optional stateless Node gateway that forwards `/api`, `/media` and `/health` to the Worker.  | Render or Azure (only if still used) |

The gateway has no database, sessions or business rules. Authentication, CORS, rate limiting and
cookies are all handled by the Worker. `prisma/` holds the retired PostgreSQL schema and
`seed-data.json` for reference only; nothing at runtime uses them.

## Worker API

```bash
cd worker
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local      # apply migrations to the local D1
npm run dev                   # http://localhost:8787
npm run typecheck && npm test
```

Configuration (`wrangler.jsonc` vars, or `wrangler secret put` for secrets):

| Variable                          | Purpose                                                                  |
| --------------------------------- | ------------------------------------------------------------------------ |
| `FRONTEND_ORIGIN`                 | Comma-separated storefront origins allowed by CORS.                      |
| `ADMIN_ORIGIN`                    | Comma-separated admin origins (the only origins allowed on `/admin`).   |
| `ENABLE_COD_ORDERS`               | `"true"` enables cash-on-delivery checkout. Default off.                 |
| `ACCESS_TOKEN_TTL_SECONDS`        | Access token lifetime (default 900).                                     |
| `REFRESH_TOKEN_TTL_SECONDS`       | Customer session lifetime (default 30 days).                             |
| `ADMIN_REFRESH_TOKEN_TTL_SECONDS` | Admin session lifetime (default 12 hours).                               |
| `MEDIA_PUBLIC_BASE_URL`           | Optional absolute base for `/media` URLs; defaults to the request host. |
| `GATEWAY_SECRET` (secret)         | Only if the Node gateway is used; lets it forward the client IP.         |

### Deploying

```bash
cd worker
node scripts/check-remote-schema.mjs           # read-only drift check against live D1
npx wrangler d1 migrations apply DB --remote   # incremental, never drops tables
npx wrangler deploy
node scripts/bootstrap-admin.mjs --email you@example.com --name "Your Name"
```

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

Online payments and refunds (checkout is disabled unless `ENABLE_COD_ORDERS=true`), coupons, reviews,
CMS pages, banners, blog, SEO tools, notifications, contact forms, newsletter, site settings, guest
carts, and password-reset email. The admin dashboard hides these sections.
