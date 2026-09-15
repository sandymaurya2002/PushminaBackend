import pino from 'pino'
import { env, isDevelopment } from './env'

/**
 * Structured logging. Pretty-printed and human readable in development,
 * newline-delimited JSON in production so a log shipper can parse it.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  ...(isDevelopment
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname',
          },
        },
      }
    : {}),
  // Never let a credential reach the log, however it arrives.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.body.password',
      'req.body.currentPassword',
      'req.body.newPassword',
      'req.body.passwordHash',
      'res.headers["set-cookie"]',
      '*.password',
      '*.passwordHash',
      '*.token',
      '*.tokenHash',
      '*.RAZORPAY_KEY_SECRET',
    ],
    censor: '[redacted]',
  },
})

export type Logger = typeof logger
