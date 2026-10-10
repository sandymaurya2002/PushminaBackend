import 'dotenv/config'
import { z } from 'zod'

/**
 * Environment contract.
 *
 * The process refuses to boot if anything required is missing or malformed, so
 * a misconfigured deployment fails immediately and loudly rather than throwing
 * an obscure error on the first request that happens to need the value.
 */

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((value) => value === true || value === 'true' || value === '1')

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),
  API_BASE_URL: z.string().url().default('http://localhost:5000'),
  STOREFRONT_URL: z.string().url().default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DIRECT_URL: z.string().min(1, 'DIRECT_URL is required'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),

  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000,http://localhost:5173')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),

  STORAGE_DRIVER: z.enum(['local', 's3', 'cloudinary']).default('local'),
  UPLOAD_DIR: z.string().default('uploads'),
  MAX_UPLOAD_MB: z.coerce.number().int().positive().default(10),

  PAYMENT_PROVIDER: z.enum(['razorpay', 'mock']).default('razorpay'),
  RAZORPAY_KEY_ID: z.string().optional().default(''),
  RAZORPAY_KEY_SECRET: z.string().optional().default(''),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional().default(''),

  SMTP_HOST: z.string().optional().default(''),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_SECURE: booleanish.default(false),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASSWORD: z.string().optional().default(''),
  MAIL_FROM: z.string().default('Pushmina <care@pushmina.com>'),

  FREE_SHIPPING_THRESHOLD: z.coerce.number().nonnegative().default(4999),
  STANDARD_SHIPPING_FEE: z.coerce.number().nonnegative().default(149),
  EXPRESS_SHIPPING_FEE: z.coerce.number().nonnegative().default(399),
  GST_RATE: z.coerce.number().min(0).max(1).default(0.05),
  COD_LIMIT: z.coerce.number().nonnegative().default(20000),

  SEED_ADMIN_EMAIL: z.string().email().default('admin@pushmina.com'),
  SEED_ADMIN_PASSWORD: z.string().min(8).default('Admin@12345'),
  SEED_ADMIN_NAME: z.string().default('Pushmina Administrator'),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(600),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
})

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  • ${issue.path.join('.')}: ${issue.message}`)
    .join('\n')
  // eslint-disable-next-line no-console
  console.error(`\nInvalid environment configuration:\n${issues}\n`)
  console.error('Copy .env.example to .env and fill in the missing values.\n')
  process.exit(1)
}

export const env = parsed.data

export const isProduction = env.NODE_ENV === 'production'
export const isDevelopment = env.NODE_ENV === 'development'
export const isTest = env.NODE_ENV === 'test'

/**
 * Razorpay needs both halves of the key pair. Without them the payment module
 * falls back to a fully-functional local mock so the entire order → payment →
 * refund lifecycle can be exercised offline, which is exactly what local
 * development against a local database needs.
 */
export const paymentsLive = Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET)

export const mailLive = Boolean(env.SMTP_HOST)
