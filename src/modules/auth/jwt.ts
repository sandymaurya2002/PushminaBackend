import jwt, { type SignOptions } from 'jsonwebtoken'
import { env } from '../../config/env'
import { UnauthorizedError } from '../../utils/errors'

/**
 * Access tokens are short-lived JWTs; refresh tokens are opaque random strings
 * stored hashed in the database (see utils/tokens.ts), so a refresh token can
 * be revoked server-side. A JWT alone cannot be.
 */

export type TokenAudience = 'customer' | 'admin'

export interface AccessTokenPayload {
  sub: string
  aud: TokenAudience
  email: string
}

export function signAccessToken(payload: AccessTokenPayload): string {
  const options: SignOptions = {
    expiresIn: env.JWT_ACCESS_TTL as SignOptions['expiresIn'],
    issuer: 'pushmina-api',
  }
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, options)
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      issuer: 'pushmina-api',
    })
    if (typeof decoded === 'string') throw new Error('Unexpected token payload')
    return decoded as unknown as AccessTokenPayload
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new UnauthorizedError('Your session has expired. Please sign in again.')
    }
    throw new UnauthorizedError('Invalid authentication token')
  }
}

/** Pulls a bearer token out of the Authorization header. */
export function extractBearer(header?: string): string | null {
  if (!header) return null
  const [scheme, token] = header.split(' ')
  if (!token || scheme.toLowerCase() !== 'bearer') return null
  return token.trim()
}
