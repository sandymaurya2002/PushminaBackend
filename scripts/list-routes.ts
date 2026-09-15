/**
 * Prints every registered route, grouped.
 *
 * Walks Express's router stack rather than maintaining a hand-written list,
 * so the output can never drift out of date with the code.
 *
 *   npx tsx scripts/list-routes.ts
 *   npx tsx scripts/list-routes.ts --full
 */
import { createApp } from '../src/app'

interface Layer {
  route?: { path: string; methods: Record<string, boolean> }
  name?: string
  handle?: { stack?: Layer[] }
  regexp?: RegExp
}

/** Recovers the mount path a sub-router was attached at. */
function extractPrefix(layer: Layer): string {
  const source = layer.regexp?.source ?? ''
  if (!source.startsWith('^\\/')) return ''

  const cleaned = source
    .replace('^\\/', '/')
    .replace('\\/?(?=\\/|$)', '')
    .replace('(?=\\/|$)', '')
    .replace('\\/?$', '')
    .replace(/\\\//g, '/')
    // A router mounted at '/' leaves a bare '/?' behind; it is not part of
    // the path and would render as "/api/v1/?/products".
    .replace(/\/?\?$/, '')

  return cleaned === '/' ? '' : cleaned
}

function walk(stack: Layer[], prefix = '', out: string[] = []): string[] {
  for (const layer of stack) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods)
        .map((method) => method.toUpperCase())
        .join('|')
      const path = (prefix + layer.route.path).replace(/\/{2,}/g, '/')
      out.push(`${methods.padEnd(8)} ${path}`)
    } else if (layer.handle && layer.handle.stack) {
      walk(layer.handle.stack, prefix + extractPrefix(layer), out)
    }
  }
  return out
}

const app = createApp()
const router = (app as unknown as { _router?: { stack: Layer[] } })._router
const routes = router ? walk(router.stack) : []
const unique = Array.from(new Set(routes)).sort((a, b) => a.slice(9).localeCompare(b.slice(9)))

const admin = unique.filter((route) => route.includes('/admin'))
const publicRoutes = unique.filter((route) => !route.includes('/admin'))

if (process.argv.includes('--full')) {
  console.log('\n--- PUBLIC / CUSTOMER ---')
  publicRoutes.forEach((route) => console.log(`  ${route}`))
  console.log('\n--- ADMIN ---')
  admin.forEach((route) => console.log(`  ${route}`))
  console.log('')
}

console.log(`Public / customer endpoints : ${publicRoutes.length}`)
console.log(`Admin endpoints             : ${admin.length}`)
console.log(`Total                       : ${unique.length}`)

process.exit(0)
