#!/usr/bin/env node
/**
 * Dual-currency (INR / USD) end-to-end test against a LOCAL stack only:
 *   Worker      `npx wrangler dev`  (http://127.0.0.1:8787, local D1, migration 0004 applied)
 *   Storefront  `next dev -p 3100`  (D:\Pashmore, .env.local pointing at the Worker)
 *
 * Creates a product with separate India (₹) and international ($) prices,
 * then shops it as an Indian and as a US customer through the storefront's
 * own /api routes: display, bag, checkout, payment session and order history.
 * Leaves the orders as history and archives the test product.
 *
 * Usage:  ADMIN_EMAIL=... ADMIN_PASSWORD=... node scripts/e2e-currency.mjs
 * Optional: WORKER_URL, STOREFRONT_URL (both must be localhost).
 */
import { randomBytes } from 'node:crypto'

const WORKER = (process.env.WORKER_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '')
const STORE = (process.env.STOREFRONT_URL ?? 'http://localhost:3100').replace(/\/+$/, '')
const ADMIN_EMAIL = process.env.ADMIN_EMAIL
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD

for (const url of [WORKER, STORE]) {
  if (!['localhost', '127.0.0.1'].includes(new URL(url).hostname)) {
    console.error(`Refusing to run against ${url}: this script only targets a local stack.`)
    process.exit(2)
  }
}
if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error('Set ADMIN_EMAIL and ADMIN_PASSWORD for a local admin account.')
  process.exit(2)
}

const results = []

function check(condition, message, detail) {
  if (!condition) {
    const error = new Error(message)
    error.detail = detail
    throw error
  }
}

async function step(name, fn) {
  const started = Date.now()
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`  PASS  ${name} (${Date.now() - started} ms)`)
  } catch (error) {
    results.push({ name, ok: false })
    console.log(`  FAIL  ${name}\n        ${error.message}`)
    if (error.detail !== undefined) console.log(`        ${JSON.stringify(error.detail).slice(0, 800)}`)
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
  const payload = (response.headers.get('content-type') ?? '').includes('json') ? await response.json() : await response.text()
  return { status: response.status, body: payload, data: payload?.data }
}

async function worker(path, headers = {}) {
  const response = await fetch(`${WORKER}/api/v1${path}`, { headers: { Accept: 'application/json', ...headers } })
  const payload = await response.json()
  return { status: response.status, body: payload, data: payload?.data, meta: payload?.meta }
}

/** A browser: cookie jar plus the storefront's /api routes and pages. */
function createShopper() {
  const jar = new Map()
  const cookieHeader = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
  const store = (response) => {
    for (const header of response.headers.getSetCookie()) {
      const [pair, ...attributes] = header.split(';')
      const index = pair.indexOf('=')
      const name = pair.slice(0, index).trim()
      const value = pair.slice(index + 1).trim()
      if (value === '' || attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute))) jar.delete(name)
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
      const payload = (response.headers.get('content-type') ?? '').includes('json') ? await response.json() : await response.text()
      return { status: response.status, body: payload, data: payload?.data }
    },
    async page(path) {
      const response = await fetch(`${STORE}${path}`, {
        redirect: 'manual',
        headers: { 'User-Agent': 'pashmore-e2e/1.0', ...(jar.size ? { Cookie: cookieHeader() } : {}) },
      })
      store(response)
      return { status: response.status, html: decode(await response.text()) }
    },
  }
}

const decode = (html) =>
  html.replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/<!-- -->/g, '')

/** The markup a shopper sees, without the React payload (its "$1a"-style references look like dollar amounts). */
const visible = (html) => html.replace(/<script[\s\S]*?<\/script>/g, '')

const inr = (value) => `₹${value.toLocaleString('en-IN')}`
const usd = (value) => `$${value.toLocaleString('en-US')}`

/* ------------------------------------------------------------------ */

const runId = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`
const ctx = {}

const PRICE = { inr: 12500, inrCompare: 15000, usd: 189, usdCompare: 229 }
const VARIANT_B = { inr: 13500, usd: 205 }

const indiaAddress = {
  fullName: 'Asha Rao',
  phone: '9876543210',
  line1: '12 Residency Road',
  line2: '',
  city: 'Bengaluru',
  state: 'Karnataka',
  postalCode: '560025',
  country: 'India',
}
const usAddress = {
  fullName: 'Emma Clarke',
  phone: '+1 415 555 0134',
  line1: '500 Market Street',
  line2: 'Suite 12',
  city: 'San Francisco',
  state: 'CA',
  postalCode: '94105',
  country: 'United States',
}

/** Category, material, image and two colours borrowed from an existing product, so it can be published. */
let template = null

function productBody(overrides = {}) {
  return {
    name: `E2E Dual Price Stole ${runId}`,
    slug: `e2e-dual-price-stole-${runId}`,
    tagline: 'Hand-woven, priced for India and abroad',
    description: 'A test piece for the dual-currency checkout.',
    categoryId: template.categoryId,
    materialId: template.materialId,
    colorIds: template.colorIds,
    sizeIds: template.sizeIds,
    images: [{ url: template.image.url, alt: template.image.alt || 'E2E stole', isPrimary: true }],
    price: PRICE.inr,
    compareAtPrice: PRICE.inrCompare,
    priceUsd: PRICE.usd,
    compareAtPriceUsd: PRICE.usdCompare,
    status: 'PUBLISHED',
    variants: [
      { sku: `E2E-${runId}-A`, ...template.options[0], inventory: 20, isActive: true },
      {
        sku: `E2E-${runId}-B`,
        ...template.options[1],
        inventory: 20,
        isActive: true,
        price: VARIANT_B.inr,
        priceUsd: VARIANT_B.usd,
      },
    ],
    ...overrides,
  }
}

/**
 * What the admin form sends: the whole product, variant ids kept. Variant A
 * follows the product price (the form moves it with the product's ₹ price and
 * sends a blank $ override); variant B keeps its own prices.
 */
function updateBody(product, overrides) {
  const price = overrides.price ?? product.price
  return productBody({
    variants: product.raw.variants.map((variant) => {
      const own = variant.sku.endsWith('-B')
      return {
        id: variant.id,
        sku: variant.sku,
        colorId: variant.colorId,
        sizeId: variant.sizeId,
        inventory: variant.inventory,
        isActive: true,
        price: own ? VARIANT_B.inr : price,
        priceUsd: own ? VARIANT_B.usd : null,
      }
    }),
    ...overrides,
  })
}

console.log(`\nPashmore dual-currency run ${runId}\n  Worker     ${WORKER}\n  Storefront ${STORE}\n`)

await step('Stack is up and the admin signs in', async () => {
  const health = await fetch(`${WORKER}/health`).catch(() => null)
  check(health && health.status < 500, 'Worker is not answering on /health')
  const login = await admin('POST', '/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
  check(login.status === 200, `Admin login failed (HTTP ${login.status})`, login.body)
  adminToken = login.data.tokens.accessToken

  const list = await admin('GET', '/products?status=PUBLISHED&limit=50')
  for (const entry of list.data ?? []) {
    const { raw, images } = (await admin('GET', `/products/${entry.id}`)).data
    const options = raw.variants
      .map((variant) => ({ colorId: variant.colorId, sizeId: variant.sizeId }))
      .filter((option, index, all) => all.findIndex((other) => other.colorId === option.colorId && other.sizeId === option.sizeId) === index)
    if (raw.categoryId && images?.length && options.length >= 2) {
      template = { ...raw, image: images[0], options }
      break
    }
  }
  check(template, 'Need a published product with a category, an image and two variants to borrow from')
})

/* 1. Product creation: both prices required, stored separately, never converted */
await step('1. Creating a product without the USD price is refused', async () => {
  const body = productBody()
  delete body.priceUsd
  const response = await admin('POST', '/products', body)
  check(response.status === 422, `Create without USD answered ${response.status}`, response.body)
  check(JSON.stringify(response.body).includes('priceUsd'), 'The error does not point at the USD price', response.body)
})

await step('1a. Admin creates a product with India and international prices', async () => {
  const response = await admin('POST', '/products', productBody())
  check(response.status === 201, `Create failed (HTTP ${response.status})`, response.body)
  ctx.product = response.data
  check(ctx.product.price === PRICE.inr && ctx.product.priceUsd === PRICE.usd, 'Prices not stored as entered', ctx.product)
  check(ctx.product.compareAtPriceUsd === PRICE.usdCompare, 'USD compare-at price not stored', ctx.product)
  ctx.variantA = ctx.product.variants.find((variant) => variant.sku.endsWith('-A'))
  ctx.variantB = ctx.product.variants.find((variant) => variant.sku.endsWith('-B'))
  check(ctx.variantA && ctx.variantB, 'Variants missing', ctx.product.variants)
})

await step('1b. Each price can be changed on its own', async () => {
  const usdOnly = await admin('PUT', `/products/${ctx.product.id}`, updateBody(ctx.product, { priceUsd: 199 }))
  check(usdOnly.status === 200, `USD update failed (HTTP ${usdOnly.status})`, usdOnly.body)
  check(usdOnly.data.price === PRICE.inr && usdOnly.data.priceUsd === 199, 'Changing USD touched INR', usdOnly.data)

  const inrOnly = updateBody(usdOnly.data, { price: 12900 })
  delete inrOnly.priceUsd
  const inrUpdate = await admin('PUT', `/products/${ctx.product.id}`, inrOnly)
  check(inrUpdate.status === 200, `INR update failed (HTTP ${inrUpdate.status})`, inrUpdate.body)
  check(inrUpdate.data.price === 12900 && inrUpdate.data.priceUsd === 199, 'Changing INR touched USD', inrUpdate.data)
  ctx.product = inrUpdate.data
  PRICE.inr = 12900
  PRICE.usd = 199
})

/* 2. The Worker prices by currency / country */
await step('2. The Worker serves each currency its own entered price', async () => {
  const slug = ctx.product.slug
  const india = await worker(`/products/${slug}?currency=INR`)
  const abroad = await worker(`/products/${slug}?currency=USD`)
  const byCountry = await worker(`/products/${slug}`, { 'X-Client-Country': 'US' })
  check(india.data.price === PRICE.inr && india.data.currency === 'INR', 'India price wrong', india.data)
  check(abroad.data.price === PRICE.usd && abroad.data.currency === 'USD', 'International price wrong', abroad.data)
  check(byCountry.data.currency === 'USD', 'X-Client-Country: US was not priced in USD', byCountry.data)
  const b = abroad.data.variants.find((variant) => variant.id === ctx.variantB.id)
  check(b?.price === VARIANT_B.usd, 'Variant USD override not applied', abroad.data.variants)
  const a = (data) => data.variants.find((variant) => variant.id === ctx.variantA.id)?.price
  check(a(abroad.data) === PRICE.usd && a(india.data) === PRICE.inr, 'Variant A did not follow the new prices', {
    usd: a(abroad.data),
    inr: a(india.data),
  })
})

await step('2a. Products without a USD price are hidden from international listings', async () => {
  const list = await worker('/products?currency=USD&limit=100')
  check(list.status === 200, `Listing failed (HTTP ${list.status})`, list.body)
  check(list.data.some((product) => product.slug === ctx.product.slug), 'The dual-priced product is missing abroad')
  check(list.data.every((product) => product.currency === 'USD' && product.price > 0), 'A product without a USD price was listed')
  const missing = await admin('GET', '/products?pricing=missing-usd&limit=1')
  check(missing.status === 200, `Admin missing-USD filter failed (HTTP ${missing.status})`, missing.body)
  ctx.missingUsd = missing.body.meta?.total
})

/* 3. Display on the storefront */
const india = createShopper()
const abroad = createShopper()

await step('3. Region: India by default, the selector switches to US dollars', async () => {
  const detected = await india.api('GET', '/api/region')
  check(detected.data.currency === 'INR', 'Default region is not India', detected.data)
  const chosen = await abroad.api('POST', '/api/region', { country: 'US' })
  check(chosen.status === 200 && chosen.data.currency === 'USD', 'Choosing the US did not switch to USD', chosen.body)
  check(abroad.jar.get('pm_country') === 'US', 'Region cookie not set')
})

await step('3a. Product page shows ₹ in India and $ abroad', async () => {
  const path = `/products/${ctx.product.slug}`
  const shownInIndia = await eventually(async () => {
    const page = await india.page(path)
    return page.status === 200 && page.html.includes(inr(PRICE.inr)) ? page : null
  })
  check(shownInIndia, `India page does not show ${inr(PRICE.inr)}`)
  const indiaMarkup = visible(shownInIndia.html)
  const leak = indiaMarkup.indexOf(usd(PRICE.usd))
  check(leak < 0, 'India page leaks the USD price', indiaMarkup.slice(Math.max(0, leak - 300), leak + 100))
  const shownAbroad = await eventually(async () => {
    const page = await abroad.page(path)
    return page.status === 200 && page.html.includes(usd(PRICE.usd)) ? page : null
  })
  check(shownAbroad, `US page does not show ${usd(PRICE.usd)}`)
  check(!visible(shownAbroad.html).includes(inr(PRICE.inr)), 'US page leaks the INR price')
  check(!shownAbroad.html.includes(inr(PRICE.inr)), 'US page payload carries the INR price')
})

await step('3b. Cards, search and quick-view data carry the region currency', async () => {
  const cards = await abroad.api('GET', `/api/products?slugs=${ctx.product.slug}`)
  check(cards.data.products[0]?.currency === 'USD' && cards.data.products[0]?.price === PRICE.usd, 'Card data not in USD', cards.body)
  const search = await abroad.api('GET', `/api/search?q=${encodeURIComponent(`Dual Price Stole ${runId}`)}`)
  check(search.status === 200, `Search failed (HTTP ${search.status})`, search.body)
  const hit = search.data.products.find((product) => product.slug === ctx.product.slug)
  if (hit) check(hit.currency === 'USD', 'Search result not in USD', hit)
  const indiaCards = await india.api('GET', `/api/products?slugs=${ctx.product.slug}`)
  check(indiaCards.data.products[0]?.currency === 'INR', 'India card data not in INR', indiaCards.body)
})

/* 4. Bag */
await step('4. A US guest bag is priced in dollars', async () => {
  const add = await abroad.api('POST', '/api/cart/items', {
    variantId: ctx.variantA.id,
    productSlug: ctx.product.slug,
    quantity: 1,
    price: 1,
  })
  check(add.status === 200, `Add failed (HTTP ${add.status})`, add.body)
  const addB = await abroad.api('POST', '/api/cart/items', { variantId: ctx.variantB.id, productSlug: ctx.product.slug, quantity: 1 })
  const { cart } = addB.data
  check(cart.currency === 'USD', 'Bag is not in USD', cart)
  check(cart.totals.subtotal === PRICE.usd + VARIANT_B.usd, `Subtotal is ${cart.totals.subtotal}`, cart.totals)
})

await step('4a. The US shopper signs in; the bag stays in dollars', async () => {
  if (process.env.CUSTOMER_EMAIL && process.env.CUSTOMER_PASSWORD) {
    // An existing local test customer: sign-ups are limited to 5 per 10 minutes per IP.
    ctx.usCustomer = { email: process.env.CUSTOMER_EMAIL, password: process.env.CUSTOMER_PASSWORD }
    const login = await abroad.api('POST', '/api/auth/login', ctx.usCustomer)
    check(login.status === 200, `Login failed (HTTP ${login.status})`, login.body)
  } else {
    ctx.usCustomer = { firstName: 'Emma', lastName: `USD ${runId}`, email: `e2e+usd${runId}@example.com`, password: `Pashmore-${runId}-Aa1!` }
    const register = await abroad.api('POST', '/api/auth/register', ctx.usCustomer)
    check(register.status === 201, `Register failed (HTTP ${register.status})`, register.body)
  }
  const ours = new Set([ctx.variantA.id, ctx.variantB.id])
  for (const line of (await abroad.api('GET', '/api/cart')).data.cart.items) {
    if (!ours.has(line.variantId)) await abroad.api('DELETE', `/api/cart/items/${encodeURIComponent(line.key)}`)
  }
  const bag = await abroad.api('GET', '/api/cart')
  check(bag.data.cart.currency === 'USD', 'Signed-in bag is not in USD', bag.data.cart)
  check(bag.data.cart.items.length === 2, 'Guest bag was not carried into the account', bag.data.cart.items)
  check(bag.data.cart.totals.subtotal === PRICE.usd + VARIANT_B.usd, 'Signed-in bag priced differently', bag.data.cart.totals)
  ctx.usSubtotal = bag.data.cart.totals.subtotal
  ctx.usShipping = bag.data.cart.totals.shipping
})

/* 5. Checkout */
await step('5. US checkout offers dollar shipping and no cash on delivery', async () => {
  const options = await abroad.api('GET', '/api/checkout')
  check(options.status === 200, `Checkout options failed (HTTP ${options.status})`, options.body)
  check(options.data.region.currency === 'USD', 'Checkout region not USD', options.data.region)
  check(options.data.payments.cod === false, 'COD offered abroad', options.data.payments)
  check(options.data.commerce.currency === 'USD', 'Shipping rules not in USD', options.data.commerce)
  ctx.onlinePayments = options.data.payments.online
})

await step('5a. Delivery country and currency must agree', async () => {
  const toIndia = await abroad.api('POST', '/api/checkout', {
    idempotencyKey: `e2e_${randomBytes(8).toString('hex')}`,
    paymentMethod: 'RAZORPAY',
    currency: 'USD',
    address: indiaAddress,
  })
  check(toIndia.status === 409 && toIndia.body.error?.code === 'REGION_MISMATCH', `USD bag to India answered ${toIndia.status}`, toIndia.body)
  const cod = await abroad.api('POST', '/api/checkout', {
    idempotencyKey: `e2e_${randomBytes(8).toString('hex')}`,
    paymentMethod: 'COD',
    currency: 'USD',
    address: usAddress,
  })
  check(cod.status >= 400 && cod.status < 500, `COD abroad answered ${cod.status}`, cod.body)
  const stale = await abroad.api('POST', '/api/checkout', {
    idempotencyKey: `e2e_${randomBytes(8).toString('hex')}`,
    paymentMethod: 'RAZORPAY',
    currency: 'INR',
    address: usAddress,
  })
  check(stale.status === 409 && stale.body.error?.code === 'CURRENCY_CHANGED', `Stale currency answered ${stale.status}`, stale.body)
})

await step('5b. US order is saved in USD and Razorpay is asked for dollars', async () => {
  check(ctx.onlinePayments, 'Online payments are off locally (Razorpay TEST keys needed in worker/.dev.vars)')
  const placed = await abroad.api('POST', '/api/checkout', {
    idempotencyKey: `e2e_${randomBytes(8).toString('hex')}`,
    paymentMethod: 'RAZORPAY',
    shippingMethod: 'standard',
    currency: 'USD',
    address: usAddress,
  })
  check(placed.status === 201, `US order failed (HTTP ${placed.status})`, placed.body)
  ctx.usOrder = placed.data.order
  check(ctx.usOrder.currency === 'USD', 'Order not saved in USD', ctx.usOrder)
  check(ctx.usOrder.totals.subtotal === ctx.usSubtotal, 'Order subtotal differs from the bag', ctx.usOrder.totals)
  check(ctx.usOrder.totals.total === ctx.usSubtotal + ctx.usShipping, 'Order total wrong', ctx.usOrder.totals)
  const payment = placed.data.payment
  check(payment?.currency === 'USD', 'Payment session not in USD', payment)
  check(payment.amount === Math.round(ctx.usOrder.totals.total * 100), `Gateway amount ${payment.amount} is not the total in cents`, payment)
  check(/^order_/.test(payment.razorpayOrderId), 'No Razorpay order id', payment)
  ctx.usPayment = payment
})

/* 6. India customer, same product */
// The same account, now shopping from India (one sign-up per run keeps clear of the sign-up rate limit).
await step('6. Shopping from India, the same customer buys the piece in rupees (COD)', async () => {
  const login = await india.api('POST', '/api/auth/login', { email: ctx.usCustomer.email, password: ctx.usCustomer.password })
  check(login.status === 200, `Login failed (HTTP ${login.status})`, login.body)
  const add = await india.api('POST', '/api/cart/items', { variantId: ctx.variantA.id, productSlug: ctx.product.slug, quantity: 1 })
  check(add.status === 200 && add.data.cart.currency === 'INR', 'India bag not in INR', add.body)
  check(add.data.cart.totals.subtotal === PRICE.inr, `India subtotal ${add.data.cart.totals.subtotal}`, add.data.cart.totals)
  const options = await india.api('GET', '/api/checkout')
  check(options.data.payments.cod === true && options.data.region.currency === 'INR', 'India checkout options wrong', options.data)

  const abroadAddress = await india.api('POST', '/api/checkout', {
    idempotencyKey: `e2e_${randomBytes(8).toString('hex')}`,
    paymentMethod: 'COD',
    currency: 'INR',
    address: usAddress,
  })
  check(abroadAddress.status === 409 && abroadAddress.body.error?.code === 'REGION_MISMATCH', `INR bag to the US answered ${abroadAddress.status}`, abroadAddress.body)

  const placed = await india.api('POST', '/api/checkout', {
    idempotencyKey: `e2e_${randomBytes(8).toString('hex')}`,
    paymentMethod: 'COD',
    currency: 'INR',
    address: indiaAddress,
  })
  check(placed.status === 201, `India order failed (HTTP ${placed.status})`, placed.body)
  ctx.inOrder = placed.data.order
  check(ctx.inOrder.currency === 'INR' && ctx.inOrder.totals.subtotal === PRICE.inr, 'India order not in INR', ctx.inOrder)
})

/* 7. History is fixed at the price paid */
await step('7. Later price changes do not alter placed orders', async () => {
  const changed = await admin('PUT', `/products/${ctx.product.id}`, updateBody(ctx.product, { price: 14000, priceUsd: 219 }))
  check(changed.status === 200, `Price change failed (HTTP ${changed.status})`, changed.body)
  ctx.product = changed.data
  const usDetail = await admin('GET', `/orders/${ctx.usOrder.id}`)
  const inDetail = await admin('GET', `/orders/${ctx.inOrder.id}`)
  const us = usDetail.data
  const ind = inDetail.data
  check(us.currency === 'USD' && us.subtotal === ctx.usSubtotal && us.total === ctx.usOrder.totals.total, 'US order total changed', us)
  check(us.pricingCountry === 'US', 'Shopper country not recorded', us)
  check(ind.currency === 'INR' && ind.subtotal === ctx.inOrder.totals.subtotal && ind.total === ctx.inOrder.totals.total, 'India order total changed', ind)
  // The customer's own view of the order, as the storefront reads it.
  const mine = await worker(`/orders/${ctx.usOrder.id}`, { Authorization: `Bearer ${decodeURIComponent(abroad.jar.get('pm_session'))}` })
  check(mine.status === 200, `Customer order read failed (HTTP ${mine.status})`, mine.body)
  const line = mine.data.items.find((item) => item.variantId === ctx.variantA.id)
  check(line?.unitPrice === 199 && mine.data.currency === 'USD', `US order line now shows ${line?.unitPrice}`, mine.data.items)
})

await step('7a. Each customer sees their order history in the currency they paid', async () => {
  const usPage = await abroad.page(`/account/orders/${ctx.usOrder.id}`)
  check(usPage.status === 200, `US order page answered ${usPage.status}`)
  check(usPage.html.includes(usd(ctx.usOrder.totals.total)), `US order page does not show ${usd(ctx.usOrder.totals.total)}`)
  check(!/₹\d/.test(visible(usPage.html)), 'US order page shows a rupee amount')
  const inPage = await india.page(`/account/orders/${ctx.inOrder.id}`)
  check(inPage.html.includes(inr(ctx.inOrder.totals.total)), `India order page does not show ${inr(ctx.inOrder.totals.total)}`)

  // One history, each order in the currency it was placed in, whichever region is browsing.
  const history = await india.page('/account/orders')
  check(history.html.includes(usd(ctx.usOrder.totals.total)), 'Order history does not show the dollar order in dollars')
  check(history.html.includes(inr(ctx.inOrder.totals.total)), 'Order history does not show the rupee order in rupees')
})

await step('7b. Admin filters and reports keep currencies apart', async () => {
  const usdOrders = await admin('GET', '/orders?currency=USD&limit=100')
  check(usdOrders.data.some((order) => order.id === ctx.usOrder.id), 'USD filter misses the US order')
  check(usdOrders.data.every((order) => order.currency === 'USD'), 'USD filter returned rupee orders')
  const inrOrders = await admin('GET', '/orders?currency=INR&limit=100')
  check(inrOrders.data.some((order) => order.id === ctx.inOrder.id), 'INR filter misses the India order')
  const dashboard = await admin('GET', '/dashboard?days=7&currency=USD')
  check(dashboard.status === 200 && dashboard.data.currency === 'USD', 'Dashboard not available in USD', dashboard.body)
})

await step('Clean-up: cancel the unpaid US order and archive the test product', async () => {
  if (ctx.usOrder) {
    const cancel = await abroad.api('POST', `/api/orders/${ctx.usOrder.id}/cancel`, { reason: 'e2e clean-up' })
    check(cancel.status === 200, `Cancel failed (HTTP ${cancel.status})`, cancel.body)
  }
  if (ctx.product) {
    const archived = await admin('PATCH', `/products/${ctx.product.id}/status`, { status: 'ARCHIVED' })
    check(archived.status === 200, `Archive failed (HTTP ${archived.status})`, archived.body)
  }
})

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} steps passed.`)
if (ctx.missingUsd !== undefined) console.log(`Note: ${ctx.missingUsd} product(s) have no USD price yet and are hidden from international shoppers.`)
process.exit(failed.length ? 1 : 0)
