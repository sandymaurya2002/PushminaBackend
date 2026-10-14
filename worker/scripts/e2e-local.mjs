#!/usr/bin/env node
/**
 * End-to-end smoke test against a LOCAL stack only:
 *   Worker      `npx wrangler dev`  (http://127.0.0.1:8787, local D1/R2)
 *   Storefront  `next dev -p 3100`  (D:\Pashmore, .env.local pointing at the Worker)
 *
 * Drives the storefront through its own /api routes with a cookie jar, the way
 * the browser does, and the admin through the Worker's admin API, the way the
 * dashboard does. Creates a throwaway customer, orders and a banner in the
 * LOCAL database and tidies up the content it changed.
 *
 * Usage:  ADMIN_EMAIL=... ADMIN_PASSWORD=... node scripts/e2e-local.mjs
 * Optional: WORKER_URL, STOREFRONT_URL (both must be localhost).
 */
import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'

const WORKER = (process.env.WORKER_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '')
const STORE = (process.env.STOREFRONT_URL ?? 'http://localhost:3100').replace(/\/+$/, '')
const ADMIN_EMAIL = process.env.ADMIN_EMAIL
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD

for (const url of [WORKER, STORE]) {
  const host = new URL(url).hostname
  if (!['localhost', '127.0.0.1'].includes(host)) {
    console.error(`Refusing to run against ${url}: this script only targets a local stack.`)
    process.exit(2)
  }
}
if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error('Set ADMIN_EMAIL and ADMIN_PASSWORD for a local admin account.')
  process.exit(2)
}

function devVar(name) {
  try {
    const text = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8')
    return text.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim() || null
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */

const results = []
let current = ''

function check(condition, message, detail) {
  if (!condition) {
    const error = new Error(message)
    error.detail = detail
    throw error
  }
}

async function step(name, fn) {
  current = name
  const started = Date.now()
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`  PASS  ${name} (${Date.now() - started} ms)`)
  } catch (error) {
    results.push({ name, ok: false })
    console.log(`  FAIL  ${name}\n        ${error.message}`)
    if (error.detail !== undefined) console.log(`        ${JSON.stringify(error.detail).slice(0, 600)}`)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function eventually(fn, { timeoutMs = 20_000, intervalMs = 1_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await fn()
    if (last) return last
    await sleep(intervalMs)
  }
  return last
}

/* ---------- Worker admin API ---------- */

let adminToken = null

async function admin(method, path, body) {
  const response = await fetch(`${WORKER}/api/v1/admin${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const type = response.headers.get('content-type') ?? ''
  const payload = type.includes('json') ? await response.json() : await response.text()
  return { status: response.status, body: payload, data: payload?.data, headers: response.headers }
}

/* ---------- Storefront with a cookie jar ---------- */

function createShopper() {
  const jar = new Map()
  const cookieHeader = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
  const store = (response) => {
    for (const header of response.headers.getSetCookie()) {
      const [pair, ...attributes] = header.split(';')
      const index = pair.indexOf('=')
      const name = pair.slice(0, index).trim()
      const value = pair.slice(index + 1).trim()
      const expired = attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute)) || value === ''
      if (expired) jar.delete(name)
      else jar.set(name, value)
    }
  }
  return {
    jar,
    async api(method, path, body) {
      const response = await fetch(`${STORE}${path}`, {
        method,
        redirect: 'manual',
        headers: {
          Accept: 'application/json',
          Origin: STORE,
          'User-Agent': 'pashmore-e2e/1.0',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(jar.size ? { Cookie: cookieHeader() } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
      store(response)
      const type = response.headers.get('content-type') ?? ''
      const payload = type.includes('json') ? await response.json() : await response.text()
      return { status: response.status, body: payload, data: payload?.data, headers: response.headers }
    },
    async page(path) {
      const response = await fetch(`${STORE}${path}`, {
        redirect: 'manual',
        headers: { 'User-Agent': 'pashmore-e2e/1.0', ...(jar.size ? { Cookie: cookieHeader() } : {}) },
      })
      store(response)
      return { status: response.status, html: await response.text(), headers: response.headers }
    },
  }
}

const decode = (html) =>
  html.replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/<!-- -->/g, '')

/* ------------------------------------------------------------------ */

const runId = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`
const customer = {
  firstName: 'Asha',
  lastName: `E2E ${runId}`,
  email: `e2e+${runId}@example.com`,
  password: `Pashmore-${runId}-Aa1!`,
  phone: '9876543210',
}
const address = {
  fullName: 'Asha Rao',
  phone: '9876543210',
  line1: '12 Residency Road',
  line2: '',
  city: 'Bengaluru',
  state: 'Karnataka',
  postalCode: '560025',
  country: 'India',
}

const shopper = createShopper()
const ctx = {}

async function variantStock(slug, variantId) {
  const response = await fetch(`${WORKER}/api/v1/products/${slug}`, { headers: { Accept: 'application/json' } })
  const { data } = await response.json()
  return data.variants.find((variant) => variant.id === variantId)?.inventory
}

async function placeCodOrder(key = `e2e_${randomBytes(8).toString('hex')}`) {
  return shopper.api('POST', '/api/checkout', {
    idempotencyKey: key,
    paymentMethod: 'COD',
    shippingMethod: 'standard',
    address,
  })
}

async function setStatus(orderId, status, extra = {}) {
  const response = await admin('PATCH', `/orders/${orderId}/status`, { status, ...extra })
  check(response.status === 200, `Admin could not move the order to ${status} (HTTP ${response.status})`, response.body)
  return response.data
}

console.log(`\nPashmore local end-to-end run ${runId}\n  Worker     ${WORKER}\n  Storefront ${STORE}\n`)

/* 0. Stack is up */
await step('Worker and storefront are reachable', async () => {
  const health = await fetch(`${WORKER}/health`).catch(() => null)
  check(health && health.status < 500, 'Worker is not answering on /health')
  const home = await shopper.page('/')
  check(home.status === 200, `Storefront homepage answered ${home.status}`)
})

/* 1. Admin: sign in, publish homepage content, see it on the site */
await step('1. Admin signs in to the dashboard API', async () => {
  const response = await admin('POST', '/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
  check(response.status === 200, `Admin login failed (HTTP ${response.status})`, response.body)
  adminToken = response.data.tokens.accessToken
  check(adminToken, 'No admin access token returned')
})

await step('1a. Admin creates a hero banner and it appears on the homepage', async () => {
  const heading = `Winter Heritage Edit ${runId}`
  const created = await admin('POST', '/content/banners', {
    placement: 'HOME_HERO',
    mediaType: 'IMAGE',
    heading,
    subheading: 'Hand-woven in Srinagar',
    imageUrl: '/images/banners/best-sellers.png',
    imageAlt: 'Pashmina shawls',
    href: '/collections/best-sellers',
    ctaLabel: 'Shop the edit',
    sortOrder: 0,
    isActive: true,
  })
  check(created.status === 201, `Banner create failed (HTTP ${created.status})`, created.body)
  ctx.bannerId = created.data.id
  ctx.bannerHeading = heading
  const shown = await eventually(async () => decode((await shopper.page('/')).html).includes(heading))
  check(shown, 'Banner heading never appeared on the storefront homepage (revalidation not reaching the site?)')
})

await step('1b. Admin turns the banner off and the homepage falls back', async () => {
  const response = await admin('PATCH', `/content/banners/${ctx.bannerId}`, { isActive: false })
  check(response.status === 200, `Banner update failed (HTTP ${response.status})`, response.body)
  const gone = await eventually(async () => !decode((await shopper.page('/')).html).includes(ctx.bannerHeading))
  check(gone, 'Banner was still on the homepage after being switched off')
})

await step('1c. Admin edits the announcement bar and the site shows it', async () => {
  const before = await admin('GET', '/content/settings')
  ctx.previousAnnouncement = before.data?.find((entry) => entry.key === 'announcement.messages')?.value
  const message = `Complimentary gift box this week ${runId}`
  const response = await admin('PUT', '/content/settings', {
    settings: [{ key: 'announcement.messages', value: [message] }],
  })
  check(response.status === 200, `Settings update failed (HTTP ${response.status})`, response.body)
  const shown = await eventually(async () => decode((await shopper.page('/about')).html).includes(message))
  check(shown, 'Announcement text never reached the storefront')
})

await step('1d. Admin adds a redirect and the storefront applies it', async () => {
  const response = await admin('POST', '/seo/redirects', {
    fromPath: `/e2e-old-${runId}`,
    toPath: '/collections',
    statusCode: 301,
    isActive: true,
  })
  check(response.status === 201, `Redirect create failed (HTTP ${response.status})`, response.body)
  ctx.redirectId = response.data.id
  // The storefront refreshes its redirect table every 60 seconds.
  const hop = await eventually(
    async () => {
      const page = await shopper.page(`/e2e-old-${runId}`)
      return page.status === 301 ? page : null
    },
    { timeoutMs: 75_000, intervalMs: 5_000 },
  )
  check(hop, 'Redirect was not applied within 75 seconds')
  check(new URL(hop.headers.get('location'), STORE).pathname === '/collections', 'Redirect went somewhere else')
})

/* 2. Customer accounts */
await step('2. Customer registers on the storefront (session cookie, no token in body)', async () => {
  const response = await shopper.api('POST', '/api/auth/register', customer)
  check(response.status === 201, `Register failed (HTTP ${response.status})`, response.body)
  check(shopper.jar.has('pm_session') && shopper.jar.has('pm_refresh'), 'Session cookies were not set')
  check(!JSON.stringify(response.body).includes('pat_'), 'A raw token leaked into the response body')
})

await step('2a. Logout, a wrong password, then a real login', async () => {
  const logout = await shopper.api('POST', '/api/auth/logout')
  check(logout.status === 200, `Logout failed (HTTP ${logout.status})`, logout.body)
  check(!shopper.jar.has('pm_session'), 'Session cookie survived logout')
  const wrong = await shopper.api('POST', '/api/auth/login', { email: customer.email, password: 'not-the-password-1' })
  check(wrong.status === 401, `Wrong password answered ${wrong.status}`, wrong.body)
  const login = await shopper.api('POST', '/api/auth/login', { email: customer.email, password: customer.password, remember: true })
  check(login.status === 200, `Login failed (HTTP ${login.status})`, login.body)
})

await step('2b. Admin sees the customer, status, registration date and login activity', async () => {
  const list = await admin('GET', `/customers?q=${encodeURIComponent(customer.email)}`)
  check(list.status === 200 && list.data?.length === 1, 'Customer not found in the admin list', list.body)
  ctx.customerId = list.data[0].id
  check(list.data[0].createdAt, 'No registration date on the customer')
  const activity = await admin('GET', `/login-activity?q=${encodeURIComponent(customer.email)}`)
  check(activity.status === 200, `Login activity failed (HTTP ${activity.status})`, activity.body)
  const events = new Set(activity.data.map((entry) => entry.event))
  for (const event of ['REGISTER', 'LOGIN', 'LOGIN_FAILED', 'LOGOUT']) {
    check(events.has(event), `Login activity is missing a ${event} event`, [...events])
  }
})

/* 3. Catalogue, cart and stock */
await step('3. Shopper searches the catalogue and adds a piece to the bag', async () => {
  const response = await fetch(`${WORKER}/api/v1/products?limit=40`, { headers: { Accept: 'application/json' } })
  const { data } = await response.json()
  const candidates = data
    .map((product) => ({ product, variant: product.variants?.find((variant) => variant.inventory >= 3) }))
    .filter((entry) => entry.variant)
  check(candidates.length >= 2, 'Need two products with at least 3 in stock')
  ctx.item = { product: candidates[0].product, variant: candidates[0].variant }
  ctx.other = { product: candidates[1].product, variant: candidates[1].variant }

  const search = await shopper.api('GET', `/api/search?q=${encodeURIComponent(ctx.item.product.name.split(' ')[0])}`)
  check(search.status === 200, `Search failed (HTTP ${search.status})`, search.body)

  const add = await shopper.api('POST', '/api/cart/items', {
    variantId: ctx.item.variant.id,
    productSlug: ctx.item.product.slug,
    quantity: 1,
    price: 1,
  })
  check(add.status === 200, `Add to bag failed (HTTP ${add.status})`, add.body)
  const line = add.data.cart.items.find((entry) => entry.variantId === ctx.item.variant.id)
  check(line && line.unitPrice > 1, 'Bag line was not priced by the server', add.data.cart)
  ctx.stockBefore = await variantStock(ctx.item.product.slug, ctx.item.variant.id)
})

await step('3a. An out-of-stock piece cannot be added', async () => {
  const set = await admin('POST', `/products/${ctx.other.product.id}/inventory`, {
    variantId: ctx.other.variant.id,
    setTo: 0,
    reason: 'CORRECTION',
    note: 'e2e out-of-stock check',
  })
  check(set.status === 200, `Inventory update failed (HTTP ${set.status})`, set.body)
  try {
    const add = await shopper.api('POST', '/api/cart/items', {
      variantId: ctx.other.variant.id,
      productSlug: ctx.other.product.slug,
      quantity: 1,
    })
    check(add.status >= 400 && add.status < 500, `Out-of-stock add answered ${add.status}`, add.body)
  } finally {
    await admin('POST', `/products/${ctx.other.product.id}/inventory`, {
      variantId: ctx.other.variant.id,
      setTo: ctx.other.variant.inventory,
      reason: 'CORRECTION',
      note: 'e2e restore',
    })
  }
})

/* 4. Checkout */
await step('4. Checkout options come from the server (online payment needs Razorpay keys)', async () => {
  const response = await shopper.api('GET', '/api/checkout')
  check(response.status === 200, `Checkout options failed (HTTP ${response.status})`, response.body)
  ctx.onlinePayments = response.data.payments.online
  check(response.data.payments.cod === true, 'Cash on delivery should be enabled locally')
  check(response.data.commerce?.codLimit > 0, 'Commerce rules missing')
})

await step('4a. Places a COD order; a retried submission returns the same order', async () => {
  const key = `e2e_${randomBytes(8).toString('hex')}`
  const first = await placeCodOrder(key)
  check(first.status === 201, `Order failed (HTTP ${first.status})`, first.body)
  const again = await placeCodOrder(key)
  check(again.status === 200, `Retry answered ${again.status}`, again.body)
  check(again.data.order.id === first.data.order.id, 'Retry created a second order')
  ctx.order = first.data.order
  check(ctx.order.status === 'pending', `New COD order is ${ctx.order.status}`)
  const bag = await shopper.api('GET', '/api/cart')
  check(bag.data.cart.items.length === 0, 'Bag was not emptied after ordering')
  const stockAfter = await variantStock(ctx.item.product.slug, ctx.item.variant.id)
  check(stockAfter === ctx.stockBefore - 1, `Stock went ${ctx.stockBefore} -> ${stockAfter}`)
})

await step('4b. The customer sees the confirmation page', async () => {
  const page = await shopper.page(`/account/orders/${ctx.order.id}?placed=1`)
  check(page.status === 200, `Order page answered ${page.status}`)
  check(decode(page.html).includes(ctx.order.number), 'Order number not on the confirmation page')
})

/* 5. Payments */
await step('5. Razorpay webhooks: forged signatures rejected, valid duplicates handled once', async () => {
  const secret = devVar('RAZORPAY_WEBHOOK_SECRET')
  check(secret, 'RAZORPAY_WEBHOOK_SECRET is not set in worker/.dev.vars')
  const payload = JSON.stringify({
    event: 'payment.captured',
    payload: {
      payment: {
        entity: { id: `pay_e2e${runId}`, order_id: `order_e2e${runId}`, amount: 100, currency: 'INR', status: 'captured' },
      },
    },
  })
  const send = (signature, eventId) =>
    fetch(`${WORKER}/api/v1/payments/razorpay/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signature, 'X-Razorpay-Event-Id': eventId },
      body: payload,
    })
  const forged = await send('0'.repeat(64), `evt_forged_${runId}`)
  if (!ctx.onlinePayments) {
    // Without Razorpay keys the Worker refuses webhooks outright.
    check(forged.status === 503, `Webhook without Razorpay configured answered ${forged.status}`)
    console.log('        (Razorpay keys not set: checked that webhooks are refused; signature checks need TEST keys)')
    return
  }
  check(forged.status === 401, `Forged webhook answered ${forged.status}`)
  const signature = createHmac('sha256', secret).update(payload).digest('hex')
  const first = await send(signature, `evt_${runId}`)
  check(first.status === 200, `Signed webhook answered ${first.status}`, await first.text())
  const replay = await send(signature, `evt_${runId}`)
  check(replay.status === 200, `Replayed webhook answered ${replay.status}`)
  const replayBody = await replay.json()
  check(JSON.stringify(replayBody).toLowerCase().includes('duplicate'), 'Replay was not recognised as a duplicate', replayBody)
})

await step('5a. Payment state cannot be set from the browser', async () => {
  const verify = await shopper.api('POST', `/api/orders/${ctx.order.id}/verify`, {
    razorpayOrderId: 'order_fake',
    razorpayPaymentId: 'pay_fake',
    razorpaySignature: 'forged',
  })
  check(verify.status >= 400, `Forged verification answered ${verify.status}`, verify.body)
  const detail = await admin('GET', `/orders/${ctx.order.id}`)
  check(detail.data.paymentStatus !== 'PAID', 'Order became paid from a browser call')
})

/* 6-7. Fulfilment managed by the admin, visible to the customer */
await step('6. Admin moves the order through processing, packing and shipping', async () => {
  await setStatus(ctx.order.id, 'PROCESSING')
  await setStatus(ctx.order.id, 'PACKED')
  const missing = await admin('PATCH', `/orders/${ctx.order.id}/status`, { status: 'SHIPPED' })
  check(missing.status === 409, `Shipping without tracking answered ${missing.status}`, missing.body)
  await setStatus(ctx.order.id, 'SHIPPED', {
    carrier: 'Blue Dart',
    trackingNumber: `BD${runId.toUpperCase()}`,
    trackingUrl: 'https://www.bluedart.com/tracking',
  })
  await setStatus(ctx.order.id, 'OUT_FOR_DELIVERY')
  const delivered = await setStatus(ctx.order.id, 'DELIVERED')
  check(delivered.paymentStatus === 'PAID', `COD order is ${delivered.paymentStatus} after delivery`)
  const skip = await admin('PATCH', `/orders/${ctx.order.id}/status`, { status: 'PROCESSING' })
  check(skip.status === 409, `Invalid transition answered ${skip.status}`)
})

await step('7. The customer sees delivery, tracking and the timeline', async () => {
  const page = decode((await shopper.page(`/account/orders/${ctx.order.id}`)).html)
  check(page.includes('Delivered'), 'Order page does not say Delivered')
  check(page.includes(`BD${runId.toUpperCase()}`), 'Tracking number not shown to the customer')
  check(page.includes('Order updates'), 'Order timeline missing')
})

/* 8. Returns and refunds */
await step('8. Customer requests a return; admin accepts it and refunds', async () => {
  const request = await shopper.api('POST', `/api/orders/${ctx.order.id}/return`, { reason: 'The colour differs from the photos' })
  check(request.status === 200, `Return request failed (HTTP ${request.status})`, request.body)
  check(request.data.order.status === 'return_requested', `Order is ${request.data.order.status}`)
  await setStatus(ctx.order.id, 'RETURNED', { note: 'Parcel received back in good condition' })

  let detail = (await admin('GET', `/orders/${ctx.order.id}`)).data
  let refund = detail.refunds?.find((entry) => entry.status === 'REQUESTED')
  if (!refund) {
    const raised = await admin('POST', `/orders/${ctx.order.id}/refund`, { reason: 'Returned item' })
    check(raised.status === 200, `Refund request failed (HTTP ${raised.status})`, raised.body)
    detail = raised.data
    refund = detail.refunds.find((entry) => entry.status === 'REQUESTED')
  }
  check(refund, 'No refund awaiting approval', detail.refunds)
  const approved = await admin('POST', `/payments/refunds/${refund.id}/approve`)
  check(approved.status === 200, `Refund approval failed (HTTP ${approved.status})`, approved.body)

  detail = (await admin('GET', `/orders/${ctx.order.id}`)).data
  check(detail.status === 'REFUNDED', `Order is ${detail.status} after the refund`)
  check(detail.paymentStatus === 'REFUNDED', `Payment is ${detail.paymentStatus} after the refund`)
  const again = await admin('POST', `/payments/refunds/${refund.id}/approve`)
  check(again.status === 409, `Approving twice answered ${again.status}`)

  const page = decode((await shopper.page(`/account/orders/${ctx.order.id}`)).html)
  check(page.includes('Refunded'), 'Customer does not see the refund')
})

await step('8a. Customer cancels an unshipped order and the stock comes back', async () => {
  await shopper.api('POST', '/api/cart/items', { variantId: ctx.item.variant.id, productSlug: ctx.item.product.slug, quantity: 2 })
  const before = await variantStock(ctx.item.product.slug, ctx.item.variant.id)
  const placed = await placeCodOrder()
  check(placed.status === 201, `Second order failed (HTTP ${placed.status})`, placed.body)
  ctx.cancelled = placed.data.order
  check((await variantStock(ctx.item.product.slug, ctx.item.variant.id)) === before - 2, 'Stock not reserved')
  const cancel = await shopper.api('POST', `/api/orders/${ctx.cancelled.id}/cancel`, { reason: 'Ordered twice' })
  check(cancel.status === 200 && cancel.data.order.status === 'cancelled', 'Cancel failed', cancel.body)
  check((await variantStock(ctx.item.product.slug, ctx.item.variant.id)) === before, 'Stock not restored on cancel')
  const twice = await shopper.api('POST', `/api/orders/${ctx.cancelled.id}/cancel`, {})
  check(twice.status === 409, `Second cancel answered ${twice.status}`)
})

/* 9. Reporting */
await step('9. Dashboard, order filters, reports and CSV export reflect the activity', async () => {
  const dashboard = await admin('GET', '/dashboard?days=7')
  check(dashboard.status === 200, `Dashboard failed (HTTP ${dashboard.status})`, dashboard.body)
  const orders = await admin('GET', `/orders?q=${encodeURIComponent(ctx.order.number)}`)
  check(orders.status === 200 && orders.data.some((order) => order.id === ctx.order.id), 'Order search did not find the order', orders.body)
  const refunded = await admin('GET', '/orders?status=REFUNDED&limit=100')
  check(refunded.data.some((order) => order.id === ctx.order.id), 'Status filter did not include the refunded order')
  const customerDetail = await admin('GET', `/customers/${ctx.customerId}`)
  check(customerDetail.status === 200, `Customer detail failed (HTTP ${customerDetail.status})`)
  check(JSON.stringify(customerDetail.data).includes(ctx.order.number), 'Customer order history missing the order')
  const sales = await admin('GET', '/reports?type=sales&days=7')
  check(sales.status === 200 && Array.isArray(sales.data), `Sales report failed (HTTP ${sales.status})`, sales.body)
  const exported = await admin('GET', '/reports/export?type=customers&days=7')
  check(exported.status === 200 && String(exported.headers.get('content-type')).includes('text/csv'), 'CSV export failed')
  check(String(exported.body).includes(customer.email), 'CSV export does not include the new customer')
})

/* Tidy up the content this run changed (orders and the test customer stay as history). */
await step('Clean-up: restore announcement, remove test banner and redirect', async () => {
  if (ctx.previousAnnouncement !== undefined) {
    await admin('PUT', '/content/settings', { settings: [{ key: 'announcement.messages', value: ctx.previousAnnouncement }] })
  }
  if (ctx.bannerId) await admin('DELETE', `/content/banners/${ctx.bannerId}`)
  if (ctx.redirectId) await admin('DELETE', `/seo/redirects/${ctx.redirectId}`)
})

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} steps passed.`)
if (ctx.onlinePayments === false) {
  console.log('Note: online payment is off locally until Razorpay TEST keys are added to worker/.dev.vars.')
}
process.exit(failed.length ? 1 : 0)
