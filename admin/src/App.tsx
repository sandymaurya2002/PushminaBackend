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
const Payments = lazy(() => import('@/pages/Payments').then((m) => ({ default: m.Payments })))
const Refunds = lazy(() => import('@/pages/Refunds').then((m) => ({ default: m.Refunds })))
const Coupons = lazy(() => import('@/pages/Coupons').then((m) => ({ default: m.Coupons })))
const Content = lazy(() => import('@/pages/Content').then((m) => ({ default: m.Content })))
const Homepage = lazy(() => import('@/pages/Homepage').then((m) => ({ default: m.Homepage })))
const Pages = lazy(() => import('@/pages/Pages').then((m) => ({ default: m.Pages })))
const Seo = lazy(() => import('@/pages/Seo').then((m) => ({ default: m.Seo })))
const Settings = lazy(() => import('@/pages/Settings').then((m) => ({ default: m.Settings })))
const Contact = lazy(() => import('@/pages/Contact').then((m) => ({ default: m.Contact })))
const Newsletter = lazy(() =>
  import('@/pages/Newsletter').then((m) => ({ default: m.Newsletter })),
)
const LoginActivity = lazy(() =>
  import('@/pages/LoginActivity').then((m) => ({ default: m.LoginActivity })),
)
const Reports = lazy(() => import('@/pages/Reports').then((m) => ({ default: m.Reports })))

/** Screens backed by the API, with the permission each one needs. */
const GUARDED_SCREENS: Array<{ path: string; permission: string; element: ReactNode }> = [
  { path: '/payments', permission: 'payments.view', element: <Payments /> },
  { path: '/refunds', permission: 'refunds.view', element: <Refunds /> },
  { path: '/coupons', permission: 'discounts.view', element: <Coupons /> },
  { path: '/homepage', permission: 'content.view', element: <Homepage /> },
  { path: '/content', permission: 'banners.view', element: <Content /> },
  { path: '/pages', permission: 'content.view', element: <Pages /> },
  { path: '/seo', permission: 'seo.view', element: <Seo /> },
  { path: '/settings', permission: 'settings.view', element: <Settings /> },
  { path: '/contact', permission: 'contact.view', element: <Contact /> },
  { path: '/newsletter', permission: 'newsletter.view', element: <Newsletter /> },
  { path: '/login-activity', permission: 'customers.activity', element: <LoginActivity /> },
  { path: '/reports', permission: 'reports.view', element: <Reports /> },
]

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
const UNAVAILABLE_PATHS = ['/reviews', '/blog/*', '/blog', '/notifications']

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
                {GUARDED_SCREENS.map((screen) => (
                  <Route
                    key={screen.path}
                    path={screen.path}
                    element={
                      <RequirePermission permission={screen.permission}>
                        {screen.element}
                      </RequirePermission>
                    }
                  />
                ))}
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
