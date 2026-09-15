import { logger } from '../config/logger'
import { publishScheduledPosts } from './publish-scheduled-posts'
import { checkLowStock } from './low-stock-check'
import { expireStalePayments } from './expire-stale-payments'

/**
 * In-process scheduler.
 *
 * setInterval rather than a queue or a cron daemon: this runs on one local
 * machine, the jobs are idempotent, and adding Redis or BullMQ would be
 * infrastructure without a problem to solve. Each job guards its own
 * re-entrancy so a slow run cannot overlap the next tick.
 */

interface Job {
  name: string
  intervalMs: number
  run: () => Promise<void>
  running: boolean
  handle?: NodeJS.Timeout
}

const MINUTE = 60_000

const jobs: Job[] = [
  {
    name: 'publish-scheduled-posts',
    intervalMs: MINUTE,
    run: publishScheduledPosts,
    running: false,
  },
  {
    name: 'low-stock-check',
    intervalMs: 30 * MINUTE,
    run: checkLowStock,
    running: false,
  },
  {
    name: 'expire-stale-payments',
    intervalMs: 15 * MINUTE,
    run: expireStalePayments,
    running: false,
  },
]

async function execute(job: Job): Promise<void> {
  if (job.running) {
    logger.debug(`Job ${job.name} still running — skipping this tick`)
    return
  }

  job.running = true
  const started = Date.now()

  try {
    await job.run()
    logger.debug(`Job ${job.name} finished in ${Date.now() - started}ms`)
  } catch (error) {
    // A failing job must never take the API process down with it.
    logger.error({ err: error }, `Job ${job.name} failed`)
  } finally {
    job.running = false
  }
}

export function startScheduler(): void {
  for (const job of jobs) {
    job.handle = setInterval(() => void execute(job), job.intervalMs)
    job.handle.unref()
  }
  logger.info(`Scheduler started with ${jobs.length} jobs`)
}

export function stopScheduler(): void {
  for (const job of jobs) {
    if (job.handle) clearInterval(job.handle)
    job.handle = undefined
  }
  logger.info('Scheduler stopped')
}
