try {
  process.loadEnvFile()
} catch {
  // No .env file: rely on the process environment (Render, Azure).
}

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required environment variable ${name}`)
  return value
}

/** Returns origin + path prefix with no trailing slash, e.g. "https://api.example.com". */
function parseUpstream(raw: string): string {
  const url = new URL(raw)
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error('WORKER_API_URL must use https (http is allowed only for localhost)')
  }
  return url.origin + url.pathname.replace(/\/+$/, '')
}

function parsePort(raw: string | undefined): number | string {
  if (!raw) return 5000
  // iisnode passes a named pipe rather than a number.
  return /^\d+$/.test(raw) ? Number(raw) : raw
}

const gatewaySecret = required('GATEWAY_SECRET')
if (gatewaySecret.length < 32) throw new Error('GATEWAY_SECRET must be at least 32 characters')

export const env = {
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  PORT: parsePort(process.env.PORT),
  WORKER_API_URL: parseUpstream(required('WORKER_API_URL')),
  GATEWAY_SECRET: gatewaySecret,
  /** Reverse-proxy hops in front of this process (Render and Azure: 1). */
  TRUST_PROXY_HOPS: Number(process.env.TRUST_PROXY_HOPS ?? 1),
  UPSTREAM_TIMEOUT_MS: Number(process.env.UPSTREAM_TIMEOUT_MS ?? 30_000),
  MAX_BODY_BYTES: Number(process.env.MAX_BODY_MB ?? 25) * 1024 * 1024,
}
