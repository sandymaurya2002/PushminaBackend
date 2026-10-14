import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import {
  Badge,
  Card,
  ConfirmDialog,
  ErrorState,
  LoadingBlock,
  PageHeader,
  useToast,
} from '@/components/ui'
import { useAuth } from '@/lib/auth'
import { type Currency, formatDate, formatDateTime, formatPrice, ORDER_STATUS_TONE, titleCase } from '@/lib/utils'
import { describeAgent, LOGIN_EVENT_TONE, type LoginEventEntry } from '@/pages/LoginActivity'

interface CustomerDetailData {
  id: string
  email: string
  firstName: string
  lastName: string
  phone: string | null
  status: string
  emailVerified: boolean
  acceptsMarketing: boolean
  createdAt: string
  lastLoginAt: string | null
  addresses: Array<{
    id: string
    label: string
    fullName: string
    line1: string
    line2: string | null
    city: string
    state: string
    postalCode: string
    country: string
    phone: string
    isDefault: boolean
  }>
  orders: Array<{
    id: string
    orderNumber: string
    status: string
    paymentStatus: string
    paymentMethod: string
    total: number
    currency: Currency
    placedAt: string
    items: Array<{ name: string; quantity: number }>
  }>
  /** Null when the viewer lacks `customers.activity`. */
  loginActivity: LoginEventEntry[] | null
  reviews: Array<{
    id: string
    rating: number
    title: string
    status: string
    product: { slug: string; name: string }
  }>
  wishlistItems: Array<{ id: string; product: { slug: string; name: string } }>
  stats: {
    lifetimeSpend: number
    lifetimeSpendUsd: number
    paidOrders: number
    averageOrderValue: number
    averageOrderValueUsd: number
  }
}

export function CustomerDetail() {
  const { id } = useParams<{ id: string }>()
  const { can } = useAuth()
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [blocking, setBlocking] = useState(false)

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin-customer', id],
    queryFn: async () => (await api.get<CustomerDetailData>(`/admin/customers/${id}`)).data,
    enabled: Boolean(id),
  })

  const blockMutation = useMutation({
    mutationFn: async (blocked: boolean) =>
      api.post(`/admin/customers/${id}/block`, { blocked }),
    onSuccess: (_result, blocked) => {
      void queryClient.invalidateQueries({ queryKey: ['admin-customer', id] })
      setBlocking(false)
      toast({
        title: blocked ? 'Customer blocked' : 'Customer unblocked',
        description: blocked ? 'Every active session has been ended.' : undefined,
      })
    },
    onError: (caught) =>
      toast({
        title: 'Could not update',
        description: caught instanceof ApiError ? caught.message : 'Unexpected error.',
        tone: 'error',
      }),
  })

  if (isLoading) return <LoadingBlock rows={10} />
  if (error) return <ErrorState error={error} retry={() => void refetch()} />
  if (!data) return null

  return (
    <>
      <Link
        to="/customers"
        className="mb-5 inline-flex items-center gap-1.5 text-[0.6875rem] uppercase tracking-[0.12em] text-taupe transition-colors hover:text-charcoal"
      >
        <ChevronLeft className="h-3.5 w-3.5" strokeWidth={1.5} />
        All customers
      </Link>

      <PageHeader
        title={`${data.firstName} ${data.lastName}`}
        description={`${data.email} · joined ${formatDate(data.createdAt)}`}
        actions={
          can('customers.block') && (
            <button
              type="button"
              onClick={() => setBlocking(true)}
              className={data.status === 'BLOCKED' ? 'btn-outline' : 'btn-danger'}
            >
              {data.status === 'BLOCKED' ? 'Unblock' : 'Block account'}
            </button>
          )
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <div className="card p-5">
          <p className="eyebrow text-taupe">Lifetime spend</p>
          <p className="mt-2 font-serif text-2xl text-charcoal">
            {formatPrice(data.stats.lifetimeSpend)}
          </p>
          {data.stats.lifetimeSpendUsd > 0 && (
            <p className="mt-1 text-sm text-mocha">+ {formatPrice(data.stats.lifetimeSpendUsd, 'USD')}</p>
          )}
        </div>
        <div className="card p-5">
          <p className="eyebrow text-taupe">Paid orders</p>
          <p className="mt-2 font-serif text-2xl text-charcoal">{data.stats.paidOrders}</p>
        </div>
        <div className="card p-5">
          <p className="eyebrow text-taupe">Average order</p>
          <p className="mt-2 font-serif text-2xl text-charcoal">
            {formatPrice(data.stats.averageOrderValue)}
          </p>
          {data.stats.averageOrderValueUsd > 0 && (
            <p className="mt-1 text-sm text-mocha">{formatPrice(data.stats.averageOrderValueUsd, 'USD')} international</p>
          )}
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card title="Orders">
            {data.orders.length === 0 ? (
              <p className="px-5 py-10 text-center text-sm text-taupe">No orders yet.</p>
            ) : (
              <ul className="divide-y divide-line">
                {data.orders.map((order) => (
                  <li key={order.id} className="flex items-center gap-4 px-5 py-3.5">
                    <Link
                      to={`/orders/${order.id}`}
                      className="text-sm text-charcoal hover:text-gold"
                    >
                      {order.orderNumber}
                    </Link>
                    <span className="flex-1 truncate text-xs text-taupe">
                      {formatDate(order.placedAt)} ·{' '}
                      {order.items.map((item) => `${item.name} ×${item.quantity}`).join(', ')}
                    </span>
                    <span className="hidden text-[0.6875rem] text-taupe sm:inline">
                      {order.paymentMethod === 'COD' ? 'COD' : 'Online'} ·{' '}
                      {titleCase(order.paymentStatus).toLowerCase()}
                    </span>
                    <Badge className={ORDER_STATUS_TONE[order.status]}>{titleCase(order.status)}</Badge>
                    <span className="shrink-0 text-sm text-charcoal">
                      {formatPrice(order.total, order.currency)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {data.loginActivity && (
            <Card
              title="Login activity"
              actions={
                <Link
                  to={`/login-activity?q=${encodeURIComponent(data.email)}`}
                  className="text-[0.6875rem] uppercase tracking-[0.1em] text-taupe hover:text-charcoal"
                >
                  View all
                </Link>
              }
            >
              {data.loginActivity.length === 0 ? (
                <p className="px-5 py-8 text-center text-sm text-taupe">No sign-ins recorded yet.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {data.loginActivity.map((entry) => (
                    <li key={entry.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                      <Badge className={LOGIN_EVENT_TONE[entry.event] ?? 'border-line-strong text-mocha'}>
                        {titleCase(entry.event)}
                      </Badge>
                      <span className="flex-1 truncate text-xs text-mocha" title={entry.userAgent ?? undefined}>
                        {describeAgent(entry.userAgent)}
                        {entry.ip && <span className="ml-2 font-mono text-taupe">{entry.ip}</span>}
                      </span>
                      <span className="shrink-0 text-[0.6875rem] text-taupe">
                        {formatDateTime(entry.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}

          {data.reviews.length > 0 && (
            <Card title="Reviews">
              <ul className="divide-y divide-line">
                {data.reviews.map((review) => (
                  <li key={review.id} className="px-5 py-3.5">
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="text-sm text-charcoal">
                        {'★'.repeat(review.rating)}
                        <span className="text-line-strong">{'★'.repeat(5 - review.rating)}</span>
                        <span className="ml-2">{review.title}</span>
                      </p>
                      <Badge className="border-line-strong text-taupe">{review.status}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-taupe">on {review.product.name}</p>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <Card title="Details">
            <dl className="space-y-3 px-5 py-4 text-sm">
              <div>
                <dt className="eyebrow text-taupe">Account status</dt>
                <dd className="mt-0.5">
                  <Badge
                    className={
                      data.status === 'BLOCKED'
                        ? 'border-burgundy/40 text-burgundy'
                        : 'border-success/40 text-success'
                    }
                  >
                    {titleCase(data.status)}
                  </Badge>
                </dd>
              </div>
              <div>
                <dt className="eyebrow text-taupe">Registered</dt>
                <dd className="mt-0.5 text-charcoal">{formatDateTime(data.createdAt)}</dd>
              </div>
              <div>
                <dt className="eyebrow text-taupe">Email</dt>
                <dd className="mt-0.5 break-all text-charcoal">{data.email}</dd>
              </div>
              <div>
                <dt className="eyebrow text-taupe">Phone</dt>
                <dd className="mt-0.5 text-charcoal">{data.phone ?? '—'}</dd>
              </div>
              <div>
                <dt className="eyebrow text-taupe">Last signed in</dt>
                <dd className="mt-0.5 text-charcoal">{formatDateTime(data.lastLoginAt)}</dd>
              </div>
              <div>
                <dt className="eyebrow text-taupe">Marketing</dt>
                <dd className="mt-0.5 text-charcoal">
                  {data.acceptsMarketing ? 'Opted in' : 'Not opted in'}
                </dd>
              </div>
            </dl>
          </Card>

          <Card title={`Addresses (${data.addresses.length})`}>
            {data.addresses.length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-taupe">No saved addresses.</p>
            ) : (
              <ul className="divide-y divide-line">
                {data.addresses.map((address) => (
                  <li key={address.id} className="px-5 py-4">
                    <div className="flex items-baseline justify-between">
                      <p className="eyebrow text-taupe">{address.label}</p>
                      {address.isDefault && (
                        <span className="text-[0.625rem] uppercase tracking-[0.1em] text-gold">
                          Default
                        </span>
                      )}
                    </div>
                    <address className="mt-2 text-sm not-italic leading-relaxed text-mocha">
                      <span className="text-charcoal">{address.fullName}</span>
                      <br />
                      {address.line1}
                      <br />
                      {address.line2 && (
                        <>
                          {address.line2}
                          <br />
                        </>
                      )}
                      {address.city}, {address.state} {address.postalCode}
                      <br />
                      {address.phone}
                    </address>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {data.wishlistItems.length > 0 && (
            <Card title={`Wishlist (${data.wishlistItems.length})`}>
              <ul className="divide-y divide-line">
                {data.wishlistItems.map((item) => (
                  <li key={item.id} className="px-5 py-2.5 text-sm text-mocha">
                    {item.product.name}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={blocking}
        onClose={() => setBlocking(false)}
        onConfirm={() => blockMutation.mutate(data.status !== 'BLOCKED')}
        busy={blockMutation.isPending}
        danger={data.status !== 'BLOCKED'}
        confirmLabel={data.status === 'BLOCKED' ? 'Unblock' : 'Block'}
        title={data.status === 'BLOCKED' ? 'Unblock this customer?' : 'Block this customer?'}
        message={
          data.status === 'BLOCKED'
            ? 'They will be able to sign in and place orders again.'
            : 'They will be signed out everywhere immediately and will not be able to sign in or place orders. Order history is kept.'
        }
      />
    </>
  )
}
