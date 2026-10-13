import { Suspense, lazy } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAuth } from '@/lib/auth'
import { Layout } from '@/components/Layout'
import { EmptyState, Spinner } from '@/components/ui'
import { Login } from '@/pages/Login'
import { Dashboard } from '@/pages/Dashboard'

/* Route-level code splitting: the admin has a lot of screens and there is no
   reason to ship the blog editor to someone who only opens Orders. */
const Products = lazy(() => import('@/pages/Products').then((m) => ({ default: m.Products })))
const ProductForm = lazy(() =>
  import('@/pages/ProductForm').then((m) => ({ default: m.ProductForm })),
)
const Taxonomy = lazy(() => import('@/pages/Taxonomy').then((m) => ({ default: m.Taxonomy })))
const Collections = lazy(() =>
  import('@/pages/Collections').then((m) => ({ default: m.Collections })),
)
const Merchandising = lazy(() =>
  import('@/pages/Merchandising').then((m) => ({ default: m.Merchandising })),
)
const Orders = lazy(() => import('@/pages/Orders').then((m) => ({ default: m.Orders })))
const OrderDetail = lazy(() =>
  import('@/pages/OrderDetail').then((m) => ({ default: m.OrderDetail })),
)
const Customers = lazy(() => import('@/pages/Customers').then((m) => ({ default: m.Customers })))
const CustomerDetail = lazy(() =>
  import('@/pages/CustomerDetail').then((m) => ({ default: m.CustomerDetail })),
)
const Media = lazy(() => import('@/pages/Media').then((m) => ({ default: m.Media })))
const Admins = lazy(() => import('@/pages/Admins').then((m) => ({ default: m.Admins })))
const Audit = lazy(() => import('@/pages/Audit').then((m) => ({ default: m.Audit })))
const Account = lazy(() => import('@/pages/Account').then((m) => ({ default: m.Account })))

function FullScreenLoader() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-ivory">
      <Spinner className="h-6 w-6 text-taupe" />
    </div>
  )
}

/** Blocks unauthenticated access and remembers where the user was heading. */
function RequireAuth({ children }: { children: ReactNode }) {
  const { admin, loading } = useAuth()
  const location = useLocation()

  if (loading) return <FullScreenLoader />
  if (!admin) return <Navigate to="/login" state={{ from: location }} replace />

  return <>{children}</>
}

/** Renders a clear message rather than a blank screen on a forbidden route. */
function RequirePermission({
  permission,
  children,
}: {
  permission: string
  children: ReactNode
}) {
  const { can } = useAuth()

  if (!can(permission)) {
    return (
      <EmptyState
        title="You do not have access to this section"
        description="Your role does not include this permission. Ask a Super Admin if you need it."
      />
    )
  }

  return <>{children}</>
}

/** Screens from the Express admin whose APIs have not been migrated to Cloudflare yet. */
const UNAVAILABLE_PATHS = [
  '/coupons',
  '/payments',
  '/refunds',
  '/reviews',
  '/content',
  '/pages',
  '/blog/*',
  '/blog',
  '/seo',
  '/notifications',
  '/contact',
  '/newsletter',
  '/settings',
]

function Unavailable() {
  return (
    <EmptyState
      title="Not available yet"
      description="This module has not been moved to the new Cloudflare backend yet."
    />
  )
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />

      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route
          index
          element={
            <RequirePermission permission="dashboard.view">
              <Dashboard />
            </RequirePermission>
          }
        />

        <Route
          path="*"
          element={
            <Suspense fallback={<div className="skeleton h-96 w-full" />}>
              <Routes>
                <Route
                  path="/products"
                  element={
                    <RequirePermission permission="products.view">
                      <Products />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/products/new"
                  element={
                    <RequirePermission permission="products.create">
                      <ProductForm />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/products/:id"
                  element={
                    <RequirePermission permission="products.view">
                      <ProductForm />
                    </RequirePermission>
                  }
                />

                <Route
                  path="/taxonomy"
                  element={
                    <RequirePermission permission="taxonomy.view">
                      <Taxonomy />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/collections"
                  element={
                    <RequirePermission permission="collections.view">
                      <Collections />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/merchandising"
                  element={
                    <RequirePermission permission="products.merchandise">
                      <Merchandising />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/orders"
                  element={
                    <RequirePermission permission="orders.view">
                      <Orders />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/orders/:id"
                  element={
                    <RequirePermission permission="orders.view">
                      <OrderDetail />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/customers"
                  element={
                    <RequirePermission permission="customers.view">
                      <Customers />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/customers/:id"
                  element={
                    <RequirePermission permission="customers.view">
                      <CustomerDetail />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/media"
                  element={
                    <RequirePermission permission="media.view">
                      <Media />
                    </RequirePermission>
                  }
                />
                {UNAVAILABLE_PATHS.map((path) => (
                  <Route key={path} path={path} element={<Unavailable />} />
                ))}

                <Route
                  path="/admins"
                  element={
                    <RequirePermission permission="admins.view">
                      <Admins />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/audit"
                  element={
                    <RequirePermission permission="audit.view">
                      <Audit />
                    </RequirePermission>
                  }
                />
                <Route path="/account" element={<Account />} />

                <Route
                  path="*"
                  element={
                    <EmptyState
                      title="Page not found"
                      description="That admin screen does not exist."
                    />
                  }
                />
              </Routes>
            </Suspense>
          }
        />
      </Route>
    </Routes>
  )
}
