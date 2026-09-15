import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  Bell,
  Boxes,
  ChevronDown,
  CreditCard,
  FileText,
  Image,
  LayoutDashboard,
  LogOut,
  Mail,
  Menu,
  MessageSquare,
  Newspaper,
  Package,
  Palette,
  Percent,
  Search,
  Settings,
  ShieldCheck,
  ShoppingBag,
  Star,
  Users,
  X,
} from 'lucide-react'
import { useAuth } from '@/lib/auth'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

interface NavEntry {
  label: string
  to: string
  icon: typeof LayoutDashboard
  /** Hidden entirely when the signed-in role lacks this permission. */
  permission?: string
  badgeKey?: 'orders' | 'reviews' | 'contact' | 'refunds'
}

interface NavGroup {
  title: string
  entries: NavEntry[]
}

const NAV: NavGroup[] = [
  {
    title: 'Overview',
    entries: [{ label: 'Dashboard', to: '/', icon: LayoutDashboard, permission: 'dashboard.view' }],
  },
  {
    title: 'Catalogue',
    entries: [
      { label: 'Products', to: '/products', icon: Package, permission: 'products.view' },
      { label: 'Collections', to: '/collections', icon: Boxes, permission: 'collections.view' },
      { label: 'Filters & Taxonomy', to: '/taxonomy', icon: Palette, permission: 'taxonomy.view' },
      { label: 'Merchandising', to: '/merchandising', icon: Star, permission: 'products.merchandise' },
      { label: 'Discounts', to: '/coupons', icon: Percent, permission: 'discounts.view' },
    ],
  },
  {
    title: 'Sales',
    entries: [
      { label: 'Orders', to: '/orders', icon: ShoppingBag, permission: 'orders.view', badgeKey: 'orders' },
      { label: 'Payments', to: '/payments', icon: CreditCard, permission: 'payments.view' },
      { label: 'Refunds', to: '/refunds', icon: CreditCard, permission: 'refunds.view', badgeKey: 'refunds' },
      { label: 'Customers', to: '/customers', icon: Users, permission: 'customers.view' },
      { label: 'Reviews', to: '/reviews', icon: Star, permission: 'reviews.view', badgeKey: 'reviews' },
    ],
  },
  {
    title: 'Content',
    entries: [
      { label: 'Homepage & Banners', to: '/content', icon: Image, permission: 'content.view' },
      { label: 'Pages', to: '/pages', icon: FileText, permission: 'content.view' },
      { label: 'Journal', to: '/blog', icon: Newspaper, permission: 'blog.view' },
      { label: 'Media Library', to: '/media', icon: Image, permission: 'media.view' },
      { label: 'SEO', to: '/seo', icon: Search, permission: 'seo.view' },
    ],
  },
  {
    title: 'Engagement',
    entries: [
      { label: 'Notifications', to: '/notifications', icon: Bell, permission: 'notifications.view' },
      { label: 'Enquiries', to: '/contact', icon: MessageSquare, permission: 'contact.view', badgeKey: 'contact' },
      { label: 'Newsletter', to: '/newsletter', icon: Mail, permission: 'newsletter.view' },
    ],
  },
  {
    title: 'System',
    entries: [
      { label: 'Settings', to: '/settings', icon: Settings, permission: 'settings.view' },
      { label: 'Admins & Roles', to: '/admins', icon: ShieldCheck, permission: 'admins.view' },
      { label: 'Audit Log', to: '/audit', icon: FileText, permission: 'audit.view' },
    ],
  },
]

export function Layout() {
  const { admin, signOut, can } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  // Any navigation closes the mobile drawer and the account menu.
  useEffect(() => {
    setSidebarOpen(false)
    setMenuOpen(false)
  }, [location.pathname])

  /** Counts that drive the sidebar badges. Polled, not pushed — this is an
      internal tool and a websocket would be more machinery than it is worth. */
  const { data: counts } = useQuery({
    queryKey: ['sidebar-counts'],
    queryFn: async () => {
      const [orders, reviews, contact, refunds, notifications] = await Promise.all([
        can('orders.view')
          ? api.get<Record<string, number>>('/admin/dashboard/order-stats').catch(() => ({ data: {} }))
          : Promise.resolve({ data: {} }),
        can('reviews.view')
          ? api.get('/admin/reviews', { status: 'PENDING', limit: 1 }).catch(() => ({ meta: {} }))
          : Promise.resolve({ meta: {} }),
        can('contact.view')
          ? api.get('/admin/contact', { status: 'NEW', limit: 1 }).catch(() => ({ meta: {} }))
          : Promise.resolve({ meta: {} }),
        can('refunds.view')
          ? api.get('/admin/payments/refunds/all', { status: 'REQUESTED', limit: 1 }).catch(() => ({ meta: {} }))
          : Promise.resolve({ meta: {} }),
        can('notifications.view')
          ? api.get<{ count: number }>('/admin/notifications/unread-count').catch(() => ({ data: { count: 0 } }))
          : Promise.resolve({ data: { count: 0 } }),
      ])

      const orderStats = (orders as { data: Record<string, number> }).data ?? {}

      return {
        orders:
          (orderStats.PLACED ?? 0) + (orderStats.CONFIRMED ?? 0) + (orderStats.PROCESSING ?? 0),
        reviews: ((reviews as { meta?: { pendingCount?: number } }).meta?.pendingCount ?? 0),
        contact: ((contact as { meta?: { newCount?: number } }).meta?.newCount ?? 0),
        refunds: ((refunds as { meta?: { pendingCount?: number } }).meta?.pendingCount ?? 0),
        notifications: (notifications as { data: { count: number } }).data?.count ?? 0,
      }
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  })

  async function handleSignOut() {
    await signOut()
    navigate('/login', { replace: true })
  }

  const visibleGroups = NAV.map((group) => ({
    ...group,
    entries: group.entries.filter((entry) => !entry.permission || can(entry.permission)),
  })).filter((group) => group.entries.length > 0)

  return (
    <div className="flex min-h-screen bg-ivory">
      {/* Mobile scrim */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-ink/40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-line bg-white transition-transform duration-300 ease-luxe lg:static lg:translate-x-0',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-16 shrink-0 items-center justify-between border-b border-line px-5">
          <Link to="/" className="font-serif text-lg tracking-[0.22em] text-charcoal">
            PUSHMINA
          </Link>
          <button
            type="button"
            onClick={() => setSidebarOpen(false)}
            className="p-1 text-taupe lg:hidden"
            aria-label="Close menu"
          >
            <X className="h-4 w-4" strokeWidth={1.5} />
          </button>
        </div>

        <nav className="scrollbar-thin flex-1 overflow-y-auto px-3 py-4" aria-label="Admin">
          {visibleGroups.map((group) => (
            <div key={group.title} className="mb-5">
              <p className="eyebrow mb-2 px-2 text-taupe">{group.title}</p>
              <ul className="space-y-0.5">
                {group.entries.map((entry) => {
                  const badge = entry.badgeKey ? (counts?.[entry.badgeKey] ?? 0) : 0
                  return (
                    <li key={entry.to}>
                      <NavLink
                        to={entry.to}
                        end={entry.to === '/'}
                        className={({ isActive }) =>
                          cn(
                            'flex items-center gap-3 rounded px-2.5 py-2 text-sm transition-colors',
                            isActive
                              ? 'bg-charcoal text-ivory'
                              : 'text-charcoal/75 hover:bg-cream hover:text-charcoal',
                          )
                        }
                      >
                        <entry.icon className="h-4 w-4 shrink-0" strokeWidth={1.4} />
                        <span className="flex-1 truncate">{entry.label}</span>
                        {badge > 0 && (
                          <span className="rounded-full bg-gold px-1.5 py-0.5 text-[0.625rem] leading-none text-ivory">
                            {badge > 99 ? '99+' : badge}
                          </span>
                        )}
                      </NavLink>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="shrink-0 border-t border-line p-3">
          <a
            href="http://localhost:3000"
            target="_blank"
            rel="noopener noreferrer"
            className="block rounded px-2.5 py-2 text-xs text-taupe transition-colors hover:bg-cream hover:text-charcoal"
          >
            View storefront →
          </a>
        </div>
      </aside>

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-16 shrink-0 items-center justify-between gap-4 border-b border-line bg-ivory/95 px-4 backdrop-blur-md lg:px-8">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            className="p-2 text-charcoal lg:hidden"
            aria-label="Open menu"
          >
            <Menu className="h-5 w-5" strokeWidth={1.5} />
          </button>

          <div className="flex-1" />

          <Link
            to="/notifications"
            className="relative p-2 text-charcoal transition-colors hover:text-gold"
            aria-label={
              counts?.notifications
                ? `Notifications, ${counts.notifications} unread`
                : 'Notifications'
            }
          >
            <Bell className="h-[1.15rem] w-[1.15rem]" strokeWidth={1.4} />
            {(counts?.notifications ?? 0) > 0 && (
              <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-gold px-1 text-[0.5625rem] leading-none text-ivory">
                {counts!.notifications > 9 ? '9+' : counts!.notifications}
              </span>
            )}
          </Link>

          <div className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              aria-expanded={menuOpen}
              className="flex items-center gap-2.5 rounded px-2 py-1.5 transition-colors hover:bg-cream"
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-charcoal text-xs text-ivory">
                {admin?.name?.charAt(0).toUpperCase() ?? 'A'}
              </span>
              <span className="hidden text-left sm:block">
                <span className="block text-xs font-medium text-charcoal">{admin?.name}</span>
                <span className="block text-[0.625rem] text-taupe">{admin?.role.name}</span>
              </span>
              <ChevronDown className="h-3.5 w-3.5 text-taupe" strokeWidth={1.5} />
            </button>

            {menuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} aria-hidden />
                <div className="absolute right-0 z-20 mt-1 w-56 border border-line bg-white shadow-lg">
                  <div className="border-b border-line px-4 py-3">
                    <p className="truncate text-sm text-charcoal">{admin?.name}</p>
                    <p className="truncate text-xs text-taupe">{admin?.email}</p>
                  </div>
                  <Link
                    to="/account"
                    className="block px-4 py-2.5 text-sm text-charcoal transition-colors hover:bg-cream"
                  >
                    Change password
                  </Link>
                  <button
                    type="button"
                    onClick={handleSignOut}
                    className="flex w-full items-center gap-2 border-t border-line px-4 py-2.5 text-left text-sm text-burgundy transition-colors hover:bg-cream"
                  >
                    <LogOut className="h-3.5 w-3.5" strokeWidth={1.5} />
                    Sign out
                  </button>
                </div>
              </>
            )}
          </div>
        </header>

        <main className="min-w-0 flex-1 p-4 lg:p-8">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
