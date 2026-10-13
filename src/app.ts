import express, { type Express, type Request, type Response } from 'express'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'

import { env } from './config/env'

/**
 * Stateless gateway in front of the Cloudflare Worker API. It holds no
 * database, sessions or business rules: every request under /api, /media and
 * /health is forwarded verbatim, and CORS, auth, cookies and rate limits are
 * all decided by the Worker.
 */

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
])

// The Worker trusts these only from the gateway, so a client must never set them.
const CLIENT_FORBIDDEN = new Set([
  'x-gateway-secret',
  'x-client-ip',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'forwarded',
  'cf-connecting-ip',
])

// fetch() already decoded the body, so these would describe the wrong bytes.
const RESPONSE_SKIP = new Set([...HOP_BY_HOP, 'content-encoding', 'set-cookie'])

function upstreamHeaders(req: Request): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    const key = name.toLowerCase()
    if (value === undefined || HOP_BY_HOP.has(key) || CLIENT_FORBIDDEN.has(key)) continue
    headers.set(key, Array.isArray(value) ? value.join(', ') : value)
  }
  headers.set('x-gateway-secret', env.GATEWAY_SECRET)
  if (req.ip) headers.set('x-client-ip', req.ip.replace(/^::ffff:/, ''))
  headers.set('x-request-id', req.header('x-request-id') ?? randomUUID())
  return headers
}

function errorBody(code: string, message: string) {
  return { success: false, error: { code, message } }
}

async function forward(req: Request, res: Response): Promise<void> {
  // Absolute-form targets ("GET http://host/api/x") still route here, so only origin-form paths may be appended.
  if (!req.originalUrl.startsWith('/') || req.originalUrl.startsWith('//')) {
    res.status(400).json(errorBody('BAD_REQUEST', 'Invalid request target.'))
    return
  }
  const target = env.WORKER_API_URL + req.originalUrl
  const hasBody = !['GET', 'HEAD'].includes(req.method)

  let upstream: globalThis.Response
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers: upstreamHeaders(req),
      body: hasBody && Buffer.isBuffer(req.body) && req.body.length ? req.body : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(env.UPSTREAM_TIMEOUT_MS),
    })
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError'
    console.error(`[gateway] ${req.method} ${req.originalUrl} failed:`, (error as Error).message)
    res
      .status(timedOut ? 504 : 502)
      .json(errorBody(timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE', 'The API is temporarily unavailable.'))
    return
  }

  res.status(upstream.status)
  upstream.headers.forEach((value, name) => {
    if (!RESPONSE_SKIP.has(name)) res.setHeader(name, value)
  })
  const cookies = upstream.headers.getSetCookie()
  if (cookies.length) res.setHeader('set-cookie', cookies)

  if (!upstream.body || req.method === 'HEAD') {
    res.end()
    return
  }
  Readable.fromWeb(upstream.body as WebReadableStream).pipe(res)
}

export function createApp(): Express {
  const app = express()
  app.set('trust proxy', env.TRUST_PROXY_HOPS)
  app.disable('x-powered-by')
  app.disable('etag')

  app.get('/gateway/health', (_req, res) => {
    res.json({
      success: true,
      data: { status: 'ok', service: 'pashmore-gateway', upstream: new URL(env.WORKER_API_URL).origin },
    })
  })

  const raw = express.raw({ type: () => true, limit: env.MAX_BODY_BYTES })
  const proxy = (req: Request, res: Response) => void forward(req, res)
  app.use('/api', raw, proxy)
  app.use('/media', proxy)
  app.all('/health', proxy)

  app.use((_req, res) => {
    res.status(404).json(errorBody('NOT_FOUND', 'Route not found.'))
  })
  app.use((error: Error & { type?: string; status?: number }, _req: Request, res: Response, _next: () => void) => {
    if (error.type === 'entity.too.large') {
      res.status(413).json(errorBody('PAYLOAD_TOO_LARGE', 'Request body is too large.'))
      return
    }
    console.error('[gateway] unhandled error:', error.message)
    res.status(error.status && error.status < 500 ? error.status : 500).json(errorBody('INTERNAL_ERROR', 'Unexpected error.'))
  })

  return app
}
