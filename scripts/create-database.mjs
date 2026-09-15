/**
 * Creates the `pushmina_db` database if it does not exist.
 *
 * `prisma migrate` can create tables but not the database itself, so this runs
 * first. It connects to the built-in `postgres` maintenance database using the
 * credentials from DATABASE_URL, then issues CREATE DATABASE.
 *
 *   node scripts/create-database.mjs
 */
import 'dotenv/config'
import pg from 'pg'

const { Client } = pg

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env first.')
  process.exit(1)
}

let parsed
try {
  parsed = new URL(url)
} catch {
  console.error(`DATABASE_URL is not a valid URL:\n  ${url}`)
  process.exit(1)
}

const targetDatabase = decodeURIComponent(parsed.pathname.replace(/^\//, '')) || 'pushmina_db'

if (parsed.password.includes('YOUR_PASSWORD')) {
  console.error(
    '\nDATABASE_URL still contains the placeholder YOUR_PASSWORD.' +
      '\nEdit .env and set your real PostgreSQL password first.\n',
  )
  process.exit(1)
}

// Connect to the maintenance database rather than the one being created.
const adminUrl = new URL(url)
adminUrl.pathname = '/postgres'
adminUrl.search = ''

const client = new Client({ connectionString: adminUrl.toString() })

try {
  await client.connect()
} catch (error) {
  console.error('\nCould not connect to PostgreSQL.\n')
  if (error.code === 'ECONNREFUSED') {
    console.error('  Nothing is listening on that host and port.')
    console.error('  Is the PostgreSQL service running?')
    console.error('  Start it with:  net start postgresql-x64-17\n')
  } else if (error.code === '28P01') {
    console.error('  Password authentication failed for the user in DATABASE_URL.')
    console.error('  Check the password you set during installation.\n')
  } else {
    console.error(`  ${error.message}\n`)
  }
  process.exit(1)
}

try {
  const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
    targetDatabase,
  ])

  if (rowCount > 0) {
    console.log(`Database "${targetDatabase}" already exists — nothing to do.`)
  } else {
    // The database name cannot be parameterised, so it is quoted defensively.
    await client.query(`CREATE DATABASE "${targetDatabase.replace(/"/g, '""')}"`)
    console.log(`Created database "${targetDatabase}".`)
  }
} catch (error) {
  console.error(`Failed to create database: ${error.message}`)
  process.exit(1)
} finally {
  await client.end()
}
