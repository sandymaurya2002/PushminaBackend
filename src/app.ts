import express, { type Express } from 'express'
import helmet from 'helmet'
import cors from 'cors'
import compression from 'compression'
import cookieParser from 'cookie-parser'
import pinoHttp from 'pino-http'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { env, isDevelopment } from './config/env'
import { logger } from './config/logger'
import { generalLimiter } from './middleware/rate-limit'
import { guestSession } from './middleware/authenticate'
import { errorHandler, notFoundHandler } from './middleware/error-handler'
import { apiRouter } from './routes'
import { rawBodySaver } from './modules/payments/webhook-raw-body'

export function createApp(): Express {
  const app = express()

  // Behind a reverse proxy this makes req.ip and rate limiting see the real
  // client address. `1` = trust exactly one hop, never `true`, which would let
  // a client spoof X-Forwarded-For and evade rate limits.
  app.set('trust proxy', 1)
  app.disable('x-powered-by')

  /* ---------------------------------------------------------------- *
   * Security & infrastructure
   * ---------------------------------------------------------------- */

  app.use(
    helmet({
      // Uploaded media is served from this origin and embedded by the
      // storefront on another; without this the browser blocks the images.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: false,
    }),
  )

  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin, curl and server-to-server requests have no Origin header.
        if (!origin) return callback(null, true)
        if (env.CORS_ORIGINS.includes(origin)) return callback(null, true)
        logger.warn({ origin }, 'Blocked by CORS')
        return callback(new Error('Not allowed by CORS'))
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Idempotency-Key'],
      exposedHeaders: ['X-Total-Count'],
      maxAge: 86_400,
    }),
  )

  app.use(compression())

  app.use((req, _res, next) => {
    req.requestId = randomUUID()
    next()
  })

  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as { requestId?: string }).requestId ?? randomUUID(),
      // Health checks and static media would otherwise dominate the log.
      autoLogging: {
        ignore: (req) =>
          req.url === '/health' || Boolean(req.url?.startsWith('/uploads')),
      },
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error'
        if (res.statusCode >= 400) return 'warn'
        return isDevelopment ? 'info' : 'silent'
      },
    }),
  )

  /* ---------------------------------------------------------------- *
   * Body parsing
   *
   * The raw, unmodified body is retained for payment webhooks: the gateway
   * signs the exact bytes it sent, so verifying against re-serialised JSON
   * would fail on any difference in key order or whitespace.
   * ---------------------------------------------------------------- */

  app.use(express.json({ limit: '2mb', verify: rawBodySaver }))
  app.use(express.urlencoded({ extended: true, limit: '2mb' }))
  app.use(cookieParser())
  app.use(guestSession)

  /* ---------------------------------------------------------------- *
   * Static media
   * ---------------------------------------------------------------- */

  app.use(
    '/uploads',
    express.static(path.resolve(process.cwd(), env.UPLOAD_DIR), {
      maxAge: '30d',
      immutable: true,
      fallthrough: true,
      index: false,
      dotfiles: 'deny',
    }),
  )

  /* ---------------------------------------------------------------- *
   * Routes
   * ---------------------------------------------------------------- */

  app.get('/health', (_req, res) => {
    res.json({
      success: true,
      data: {
        status: 'ok',
        service: 'pushmina-api',
        environment: env.NODE_ENV,
        uptimeSeconds: Math.round(process.uptime()),
        timestamp: new Date().toISOString(),
      },
    })
  })

  app.use('/api/v1', generalLimiter, apiRouter)

  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}
