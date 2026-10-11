import { createApp } from './app'
import { env } from './config/env'
import { logger } from './config/logger'
import { connectDatabase, disconnectDatabase } from './db/prisma'
import { ensureUploadDirs } from './modules/media/storage'
import { startScheduler, stopScheduler } from './jobs/scheduler'

async function bootstrap(): Promise<void> {
  await ensureUploadDirs()
  await connectDatabase()

  const app = createApp()

  const onListening = () => {
    const where =
      typeof env.PORT === 'number' ? `http://localhost:${env.PORT}` : env.PORT
    logger.info(`Pushmina API listening on ${where}`)
    if (typeof env.PORT === 'number') {
      logger.info(`   Health   → http://localhost:${env.PORT}/health`)
      logger.info(`   API root → http://localhost:${env.PORT}/api/v1`)
      logger.info(`   Docs     → http://localhost:${env.PORT}/api/v1/docs`)
    }
  }

  // Render and Azure reach the process through a proxy, so a numeric port
  // must listen on every interface. process.env.PORT is read in config/env.
  // A named pipe (Windows iisnode) must be listened on with no host.
  const server =
    typeof env.PORT === 'number'
      ? app.listen(env.PORT, '0.0.0.0', onListening)
      : app.listen(env.PORT, onListening)

  startScheduler()

  /* ---------------------------------------------------------------- *
   * Graceful shutdown — stop accepting connections, drain in-flight
   * requests, then close the database pool.
   * ---------------------------------------------------------------- */

  let shuttingDown = false

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    logger.info(`${signal} received — shutting down`)

    stopScheduler()

    const forceExit = setTimeout(() => {
      logger.error('Shutdown timed out after 10s — forcing exit')
      process.exit(1)
    }, 10_000)
    forceExit.unref()

    server.close(async (error) => {
      if (error) logger.error({ err: error }, 'Error while closing HTTP server')
      try {
        await disconnectDatabase()
      } catch (dbError) {
        logger.error({ err: dbError }, 'Error while disconnecting database')
      }
      clearTimeout(forceExit)
      process.exit(error ? 1 : 0)
    })
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled promise rejection')
  })

  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught exception — exiting')
    void shutdown('uncaughtException')
  })
}

bootstrap().catch((error) => {
  logger.fatal({ err: error }, 'Failed to start Pushmina API')
  process.exit(1)
})
