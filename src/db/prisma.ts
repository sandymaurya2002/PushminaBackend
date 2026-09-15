import { PrismaClient, Prisma } from '@prisma/client'
import { isDevelopment, isProduction } from '../config/env'
import { logger } from '../config/logger'

/**
 * A single PrismaClient for the whole process.
 *
 * In development `tsx watch` reloads the module graph on every save; without
 * stashing the instance on `globalThis` each reload would open a new connection
 * pool and Postgres would run out of connections within a few minutes.
 */
/**
 * Prisma serialises Decimal columns to JSON *strings* ("8999"), which would
 * reach the storefront and break arithmetic silently: `compareAtPrice <= price`
 * becomes a lexicographic string comparison, so ₹9,499 would compare as less
 * than ₹15,999 and every discount badge would be wrong.
 *
 * Teaching Decimal to serialise as a number fixes it once, everywhere, instead
 * of relying on every mapper to remember. Money is Decimal(12,2) — far inside
 * the safe-integer range — so there is no precision loss at this boundary.
 */
;(Prisma.Decimal.prototype as unknown as { toJSON(): number }).toJSON = function toJSON(
  this: Prisma.Decimal,
): number {
  return this.toNumber()
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: isDevelopment
      ? [
          { emit: 'event', level: 'query' },
          { emit: 'event', level: 'warn' },
          { emit: 'event', level: 'error' },
        ]
      : [
          { emit: 'event', level: 'warn' },
          { emit: 'event', level: 'error' },
        ],
  })

if (isDevelopment) {
  globalForPrisma.prisma = prisma

  prisma.$on('query' as never, (event: Prisma.QueryEvent) => {
    // Only surface genuinely slow queries; logging every one drowns the console.
    if (event.duration >= 200) {
      logger.debug({ durationMs: event.duration, query: event.query }, 'slow query')
    }
  })
}

prisma.$on('warn' as never, (event: Prisma.LogEvent) => logger.warn(event.message))
prisma.$on('error' as never, (event: Prisma.LogEvent) => logger.error(event.message))

export async function connectDatabase(): Promise<void> {
  try {
    await prisma.$connect()
    const [{ version }] = await prisma.$queryRaw<Array<{ version: string }>>`SELECT version()`
    logger.info(`Database connected — ${version.split(',')[0]}`)
  } catch (error) {
    logger.error({ err: error }, 'Failed to connect to PostgreSQL')
    logger.error(
      'Check that PostgreSQL is running and that DATABASE_URL in .env is correct.',
    )
    throw error
  }
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect()
  logger.info('Database disconnected')
}

/** Narrow a thrown value to a Prisma known-request error. */
export function isPrismaError(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError
}

export { Prisma }
export const productionSafe = isProduction
