/**
 * End-to-end smoke test.
 *
 * Exercises the paths that actually matter: the catalogue, the full checkout,
 * the security properties of the payment flow, and the admin → storefront loop.
 * Runs against a live API, so it proves the wiring rather than the units.
 *
 *   npm run dev        # in another terminal
 *   npm run smoke
 */

const BASE = process.env.SMOKE_API ?? 'http://localhost:5000/api/v1'

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    failures.push(name)
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title: string): void {
  console.log(`\n${title}`)
}

interface Envelope<T> {
  success: boolean
  data: T
  meta?: Record<string, unknown>
  error?: { code: string; message: string }
}

async function call<T>(
  path: string,
  options: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Envelope<T> }> {
  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })

  const body = (await response.json().catch(() => ({ success: false }))) as Envelope<T>
  return { status: response.status, body }
}

async function main(): Promise<void> {
  console.log('\n─────────────────────────────────────────────')
  console.log(' Pushmina API smoke test')
  console.log(`  ${BASE}`)
  console.log('─────────────────────────────────────────────')

  /* ---------------- Catalogue ---------------- */
  section('Catalogue')

  const products = await call<Array<{ slug: string; price: number; name: string }>>(
    '/products?limit=5',
  )
  check('product listing responds', products.status === 200 && products.body.success)
  check('products are returned', (products.body.data?.length ?? 0) > 0)
  check(
    'price is a number, not a string',
    typeof products.body.data?.[0]?.price === 'number',
    `got ${typeof products.body.data?.[0]?.price}`,
  )

  const facets = products.body.meta?.facets as { color?: unknown[] } | undefined
  check('facets are computed', Array.isArray(facets?.color) && facets!.color!.length > 0)

  const taxonomy = await call<{ colors: Array<{ hex: string }> }>('/taxonomy')
  check('taxonomy returns colours with hex swatches', Boolean(taxonomy.body.data?.colors?.[0]?.hex))

  const filtered = await call('/products?color=ivory&sort=price-low')
  check('colour filter + sort works', filtered.status === 200)

  const search = await call<{ total: number }>('/search?q=pashmina')
  check('search returns matches', (search.body.data?.total ?? 0) > 0)

  const firstSlug = products.body.data?.[0]?.slug
  const detail = await call<{ variants: Array<{ id: string; inventory: number }> }>(
    `/products/${firstSlug}`,
  )
  check('product detail loads', detail.status === 200)
  check('product has variants', (detail.body.data?.variants?.length ?? 0) > 0)

  /* ---------------- Content ---------------- */
  section('Content')

  const homepage = await call<{ sections: unknown[]; rails: Record<string, unknown[]> }>(
    '/content/homepage',
  )
  check('homepage composition loads', homepage.status === 200)
  check('homepage has ordered sections', (homepage.body.data?.sections?.length ?? 0) > 0)
  check('homepage rails are populated', (homepage.body.data?.rails?.trending?.length ?? 0) > 0)

  const navigation = await call<{ header: unknown[]; footer: unknown[] }>('/content/navigation')
  check('navigation loads', (navigation.body.data?.header?.length ?? 0) > 0)

  const blog = await call<unknown[]>('/blog?limit=3')
  check('journal loads', (blog.body.data?.length ?? 0) > 0)

  const sitemap = await call<unknown[]>('/seo/sitemap')
  check('sitemap generates', (sitemap.body.data?.length ?? 0) > 10)

  /* ---------------- Checkout ---------------- */
  section('Checkout')

  const email = `smoke-${Date.now()}@test.local`
  const register = await call<{ tokens: { accessToken: string } }>('/auth/register', {
    method: 'POST',
    body: {
      firstName: 'Smoke',
      lastName: 'Test',
      email,
      password: 'Smoke1234',
      acceptsMarketing: false,
    },
  })
  check('registration succeeds', register.status === 201)

  const token = register.body.data?.tokens?.accessToken
  check('access token issued', Boolean(token))

  const variant = detail.body.data?.variants?.find((entry) => entry.inventory > 0)
  check('an in-stock variant exists', Boolean(variant))

  const addToCart = await call<{ totals: { subtotal: number; itemCount: number } }>(
    '/cart/items',
    { method: 'POST', token, body: { variantId: variant?.id, quantity: 1 } },
  )
  check('add to cart works', addToCart.status === 200)
  check('cart subtotal is calculated', (addToCart.body.data?.totals?.subtotal ?? 0) > 0)

  const coupon = await call<{ totals: { discount: number } }>('/cart/coupon', {
    method: 'POST',
    token,
    body: { code: 'HERITAGE10' },
  })
  check('coupon applies', (coupon.body.data?.totals?.discount ?? 0) > 0)

  const order = await call<{ id: string; orderNumber: string; status: string }>('/orders', {
    method: 'POST',
    token,
    body: {
      address: {
        fullName: 'Smoke Test',
        email,
        phone: '9810000000',
        line1: '14 Rani Jhansi Marg',
        city: 'New Delhi',
        state: 'Delhi',
        postalCode: '110054',
      },
      shippingMethod: 'standard',
      paymentMethod: 'UPI',
    },
  })
  check('order is placed', order.status === 201)
  check('order starts PENDING', order.body.data?.status === 'PENDING')

  /* ---------------- Payment security ---------------- */
  section('Payment security')

  const initiate = await call<{ providerOrderId: string }>('/payments/initiate', {
    method: 'POST',
    token,
    headers: { 'X-Idempotency-Key': `smoke-${Date.now()}` },
    body: { orderId: order.body.data?.id, method: 'UPI' },
  })
  check('payment initiates', initiate.status === 200)

  const providerOrderId = initiate.body.data?.providerOrderId

  const forged = await call('/payments/verify', {
    method: 'POST',
    body: {
      providerOrderId,
      providerPaymentId: 'pay_forged',
      signature: 'deadbeefdeadbeef',
    },
  })
  check(
    'forged signature is REJECTED',
    forged.status === 402 && forged.body.success === false,
    `status ${forged.status}`,
  )

  const signed = await call<{ signature: string }>('/payments/mock/sign', {
    method: 'POST',
    body: { providerOrderId, providerPaymentId: 'pay_smoke' },
  })

  const verified = await call<{ payment: { status: string }; order: { status: string } }>(
    '/payments/verify',
    {
      method: 'POST',
      body: {
        providerOrderId,
        providerPaymentId: 'pay_smoke',
        signature: signed.body.data?.signature,
      },
    },
  )
  check('valid signature captures payment', verified.body.data?.payment?.status === 'CAPTURED')
  check(
    'order advances to CONFIRMED in the response',
    verified.body.data?.order?.status === 'CONFIRMED',
    `got ${verified.body.data?.order?.status}`,
  )

  const replay = await call<{ alreadyProcessed: boolean }>('/payments/verify', {
    method: 'POST',
    body: {
      providerOrderId,
      providerPaymentId: 'pay_smoke',
      signature: signed.body.data?.signature,
    },
  })
  check('replayed verification is idempotent', replay.body.data?.alreadyProcessed === true)

  /* ---------------- Admin ---------------- */
  section('Admin')

  const unauthenticated = await call('/admin/dashboard')
  check('admin is blocked without a token', unauthenticated.status === 401)

  const adminLogin = await call<{ tokens: { accessToken: string }; admin: { permissions: string[] } }>(
    '/admin/auth/login',
    {
      method: 'POST',
      body: {
        email: process.env.SEED_ADMIN_EMAIL ?? 'admin@pushmina.com',
        password: process.env.SEED_ADMIN_PASSWORD ?? 'Admin@12345',
      },
    },
  )
  check('admin signs in', adminLogin.status === 200)

  const adminToken = adminLogin.body.data?.tokens?.accessToken
  check('admin has permissions', (adminLogin.body.data?.admin?.permissions?.length ?? 0) > 0)

  const dashboard = await call<{ revenue: { net: number }; totals: { products: number } }>(
    '/admin/dashboard',
    { token: adminToken },
  )
  check('dashboard loads', dashboard.status === 200)
  check('dashboard counts products', (dashboard.body.data?.totals?.products ?? 0) > 0)

  const customerTokenOnAdmin = await call('/admin/dashboard', { token })
  check(
    'a customer token cannot reach the admin API',
    customerTokenOnAdmin.status === 401,
    `status ${customerTokenOnAdmin.status}`,
  )

  /* ---------------- Admin → storefront ---------------- */
  section('Admin changes reach the storefront')

  const created = await call<{ id: string; slug: string }>('/admin/taxonomy/colors', {
    method: 'POST',
    token: adminToken,
    body: { name: `Smoke ${Date.now()}`, hex: '#123456', sortOrder: 999 },
  })
  check('admin creates a colour', created.status === 201)

  const publicTaxonomy = await call<{ colors: Array<{ slug: string }> }>('/taxonomy')
  check(
    'the new colour appears on the public filters',
    publicTaxonomy.body.data?.colors?.some((colour) => colour.slug === created.body.data?.slug) ??
      false,
  )

  const removed = await fetch(`${BASE}/admin/taxonomy/colors/${created.body.data?.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${adminToken}` },
  })
  check('admin deletes the colour again', removed.status === 204)

  /* ---------------- Summary ---------------- */
  console.log('\n─────────────────────────────────────────────')
  console.log(` ${passed} passed, ${failed} failed`)
  if (failures.length > 0) {
    console.log('\n Failures:')
    failures.forEach((name) => console.log(`   • ${name}`))
  }
  console.log('─────────────────────────────────────────────\n')

  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error('\nSmoke test could not run:', error instanceof Error ? error.message : error)
  console.error('Is the API running?  npm run dev\n')
  process.exit(1)
})
