import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import http, { type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'

const SECRET = 'test-gateway-secret-0123456789abcdef'

interface Seen {
  method: string
  url: string
  headers: IncomingHttpHeaders
  body: Buffer
}

let seen: Seen[] = []
let upstream: http.Server
let gateway: http.Server
let base = ''

before(async () => {
  upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks) })
      if (req.url === '/api/v1/slow') return
      res.setHeader('set-cookie', ['a=1; Path=/; HttpOnly', 'b=2; Path=/; HttpOnly'])
      res.setHeader('access-control-allow-origin', 'https://www.pashmore.com')
      res.setHeader('content-type', 'application/json')
      res.statusCode = req.url?.startsWith('/missing') ? 404 : 201
      res.end(JSON.stringify({ ok: true }))
    })
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))

  process.env.WORKER_API_URL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
  process.env.GATEWAY_SECRET = SECRET
  process.env.UPSTREAM_TIMEOUT_MS = '500'
  process.env.MAX_BODY_MB = '1'
  process.env.TRUST_PROXY_HOPS = '1'
  const { createApp } = await import('../src/app')
  gateway = createApp().listen(0, '127.0.0.1')
  await new Promise((resolve) => gateway.once('listening', resolve))
  base = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`
})

after(() => {
  gateway?.close()
  upstream?.closeAllConnections()
  upstream?.close()
})

test('forwards method, path, query and body, and injects the gateway secret', async () => {
  seen = []
  const response = await fetch(`${base}/api/v1/auth/login?x=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://www.pashmore.com', 'x-forwarded-for': '203.0.113.9' },
    body: JSON.stringify({ email: 'a@b.co' }),
  })
  assert.equal(response.status, 201)
  assert.deepEqual(await response.json(), { ok: true })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].method, 'POST')
  assert.equal(seen[0].url, '/api/v1/auth/login?x=1')
  assert.equal(seen[0].body.toString(), '{"email":"a@b.co"}')
  assert.equal(seen[0].headers['x-gateway-secret'], SECRET)
  assert.equal(seen[0].headers.origin, 'https://www.pashmore.com')
  // With one trusted hop, the client IP is the last X-Forwarded-For entry.
  assert.equal(seen[0].headers['x-client-ip'], '203.0.113.9')
  assert.equal(seen[0].headers['x-forwarded-for'], undefined)
})

test('clients cannot spoof the gateway secret or client IP', async () => {
  seen = []
  await fetch(`${base}/api/v1/products`, {
    headers: { 'x-gateway-secret': 'forged', 'x-client-ip': '1.2.3.4' },
  })
  assert.equal(seen[0].headers['x-gateway-secret'], SECRET)
  assert.notEqual(seen[0].headers['x-client-ip'], '1.2.3.4')
})

test('passes status, CORS headers and every Set-Cookie back', async () => {
  const response = await fetch(`${base}/api/v1/cart`)
  assert.equal(response.status, 201)
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://www.pashmore.com')
  assert.deepEqual(response.headers.getSetCookie(), ['a=1; Path=/; HttpOnly', 'b=2; Path=/; HttpOnly'])
})

test('forwards /media and /health', async () => {
  seen = []
  await fetch(`${base}/media/products/a.webp`)
  await fetch(`${base}/health`)
  assert.deepEqual(
    seen.map((entry) => entry.url),
    ['/media/products/a.webp', '/health'],
  )
})

test('does not forward unknown paths', async () => {
  seen = []
  const response = await fetch(`${base}/uploads/x.png`)
  assert.equal(response.status, 404)
  assert.equal(seen.length, 0)
})

test('refuses absolute-form request targets', async () => {
  seen = []
  const status = await new Promise<number>((resolve, reject) => {
    const { port } = gateway.address() as AddressInfo
    http
      .request({ host: '127.0.0.1', port, path: 'http://evil.example/api/v1/products' }, (res) => {
        res.resume()
        resolve(res.statusCode!)
      })
      .on('error', reject)
      .end()
  })
  assert.equal(status, 400)
  assert.equal(seen.length, 0)
})

test('rejects oversized bodies without contacting the API', async () => {
  seen = []
  const response = await fetch(`${base}/api/v1/admin/media`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: Buffer.alloc(1024 * 1024 + 1),
  })
  assert.equal(response.status, 413)
  assert.equal(seen.length, 0)
})

test('returns 504 when the API does not answer in time', async () => {
  const response = await fetch(`${base}/api/v1/slow`)
  assert.equal(response.status, 504)
  assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'UPSTREAM_TIMEOUT')
})

test('reports its own health without touching the API', async () => {
  seen = []
  const response = await fetch(`${base}/gateway/health`)
  assert.equal(response.status, 200)
  assert.equal(seen.length, 0)
})
