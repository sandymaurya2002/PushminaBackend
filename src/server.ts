import { createApp } from './app'
import { env } from './config/env'

const app = createApp()

const onListening = () => {
  console.log(`Pashmore gateway listening on ${env.PORT}, forwarding to ${env.WORKER_API_URL}`)
}

// Listen on every interface so a local reverse proxy can reach the process.
const server = app.listen(env.PORT, '0.0.0.0', onListening)

let shuttingDown = false
function shutdown(signal: string): void {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`${signal} received, draining connections`)
  const forceExit = setTimeout(() => process.exit(1), 10_000)
  forceExit.unref()
  server.close((error) => process.exit(error ? 1 : 0))
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
