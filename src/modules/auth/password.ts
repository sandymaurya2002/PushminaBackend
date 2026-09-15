import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { env } from '../../config/env'

/**
 * bcryptjs rather than native bcrypt: it needs no C++ toolchain, which matters
 * on Windows where node-gyp builds routinely fail. The cost difference is
 * irrelevant next to a 12-round work factor.
 */

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, env.BCRYPT_ROUNDS)
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash)
}

/**
 * Deliberately not draconian: length is what actually matters, and rules that
 * are too strict push people towards `Password1!` on every site they use.
 */
export const passwordSchema = z
  .string()
  .min(8, 'Use at least 8 characters.')
  .max(128, 'That password is too long.')
  .refine((value) => /[a-zA-Z]/.test(value), 'Include at least one letter.')
  .refine((value) => /[0-9]/.test(value), 'Include at least one number.')

/**
 * Compares against a throwaway hash so a request for an address that does not
 * exist takes the same time as one that does, closing a user-enumeration hole.
 */
const DUMMY_HASH = '$2a$12$abcdefghijklmnopqrstuuO7FkYIcYPbLPKR7B1JZHkhzYQDkJ4O2'

export async function fakeVerify(): Promise<void> {
  await bcrypt.compare('not-a-real-password', DUMMY_HASH)
}
