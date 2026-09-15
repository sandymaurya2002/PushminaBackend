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
const Payments = lazy(() => import('@/pages/Payments').then((m) => ({ default: m.Payments })))
const Refunds = lazy(() => import('@/pages/Refunds').then((m) => ({ default: m.Refunds })))
const Customers = lazy(() => import('@/pages/Customers').then((m) => ({ default: m.Customers })))
const CustomerDetail = lazy(() =>
  import('@/pages/CustomerDetail').then((m) => ({ default: m.CustomerDetail })),
)
const Reviews = lazy(() => import('@/pages/Reviews').then((m) => ({ default: m.Reviews })))
const Content = lazy(() => import('@/pages/Content').then((m) => ({ default: m.Content })))
const Pages = lazy(() => import('@/pages/Pages').then((m) => ({ default: m.Pages })))
const Blog = lazy(() => import('@/pages/Blog').then((m) => ({ default: m.Blog })))
const BlogForm = lazy(() => import('@/pages/BlogForm').then((m) => ({ default: m.BlogForm })))
const Media = lazy(() => import('@/pages/Media').then((m) => ({ default: m.Media })))
const Seo = lazy(() => import('@/pages/Seo').then((m) => ({ default: m.Seo })))
const Coupons = lazy(() => import('@/pages/Coupons').then((m) => ({ default: m.Coupons })))
const Notifications = lazy(() =>
  import('@/pages/Notifications').then((m) => ({ default: m.Notifications })),
)
const Contact = lazy(() => import('@/pages/Contact').then((m) => ({ default: m.Contact })))
const Newsletter = lazy(() =>
  import('@/pages/Newsletter').then((m) => ({ default: m.Newsletter })),
)
const Settings = lazy(() => import('@/pages/Settings').then((m) => ({ default: m.Settings })))
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
                  path="/coupons"
                  element={
                    <RequirePermission permission="discounts.view">
                      <Coupons />
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
                  path="/payments"
                  element={
                    <RequirePermission permission="payments.view">
                      <Payments />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/refunds"
                  element={
                    <RequirePermission permission="refunds.view">
                      <Refunds />
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
                  path="/reviews"
                  element={
                    <RequirePermission permission="reviews.view">
                      <Reviews />
                    </RequirePermission>
                  }
                />

                <Route
                  path="/content"
                  element={
                    <RequirePermission permission="content.view">
                      <Content />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/pages"
                  element={
                    <RequirePermission permission="content.view">
                      <Pages />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/blog"
                  element={
                    <RequirePermission permission="blog.view">
                      <Blog />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/blog/new"
                  element={
                    <RequirePermission permission="blog.create">
                      <BlogForm />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/blog/:id"
                  element={
                    <RequirePermission permission="blog.view">
                      <BlogForm />
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
                <Route
                  path="/seo"
                  element={
                    <RequirePermission permission="seo.view">
                      <Seo />
                    </RequirePermission>
                  }
                />

                <Route
                  path="/notifications"
                  element={
                    <RequirePermission permission="notifications.view">
                      <Notifications />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/contact"
                  element={
                    <RequirePermission permission="contact.view">
                      <Contact />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/newsletter"
                  element={
                    <RequirePermission permission="newsletter.view">
                      <Newsletter />
                    </RequirePermission>
                  }
                />

                <Route
                  path="/settings"
                  element={
                    <RequirePermission permission="settings.view">
                      <Settings />
                    </RequirePermission>
                  }
                />
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
