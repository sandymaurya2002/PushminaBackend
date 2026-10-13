import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Download, Search, ShoppingBag } from 'lucide-react'
import { api, type ApiMeta } from '@/lib/api'
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  LoadingBlock,
  PageHeader,
  Pagination,
  useToast,
} from '@/components/ui'
import { useAuth } from '@/lib/auth'
import { formatPrice, ORDER_STATUS_TONE, PAYMENT_STATUS_TONE, relativeTime } from '@/lib/utils'

interface OrderRow {
  id: string
  orderNumber: string
  email: string
  phone: string
  status: string
  total: number
  placedAt: string
  trackingNumber: string | null
  shippingMethod: string
  itemCount: number
  paymentStatus: string | null
  paymentMethod: string | null
  user: { id: string; firstName: string; lastName: string } | null
  items: Array<{ id: string; name: string; quantity: number; imageUrl: string | null }>
}

const STATUSES = ['PENDING', 'CONFIRMED', 'PACKED', 'SHIPPED', 'DELIVERED', 'CANCELLED']

export function Orders() {
  const [params, setParams] = useSearchParams()
  const { can } = useAuth()
  const { toast } = useToast()

  const [search, setSearch] = useState(params.get('q') ?? '')

  const filters = {
    q: params.get('q') ?? undefined,
    status: params.get('status') ?? undefined,
    paymentStatus: params.get('paymentStatus') ?? undefined,
    from: params.get('from') ?? undefined,
    to: params.get('to') ?? undefined,
    sort: params.get('sort') ?? 'newest',
    page: Number(params.get('page') ?? 1),
    limit: 25,
  }

  useEffect(() => {
    const timer = setTimeout(() => {
      const next = new URLSearchParams(params)
      if (search) next.set('q', search)
      else next.delete('q')
      next.delete('page')
      if (next.toString() !== params.toString()) setParams(next, { replace: true })
    }, 350)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin-orders', filters],
    queryFn: async () => {
      const result = await api.get<OrderRow[]>('/admin/orders', filters)
      return { rows: result.data, meta: result.meta as ApiMeta }
    },
  })

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    next.delete('page')
    setParams(next)
  }

  async function exportCsv() {
    try {
      await api.download('/admin/orders/export/csv', filters)
      toast({ title: 'Export started', description: 'Your CSV is downloading.' })
    } catch {
      toast({ title: 'Export failed', tone: 'error' })
    }
  }

  return (
    <>
      <PageHeader
        title="Orders"
        description="Every order placed on the storefront, with payment status and fulfilment."
        actions={
          can('orders.export') && (
            <button type="button" onClick={exportCsv} className="btn-outline">
              <Download className="h-3.5 w-3.5" strokeWidth={1.5} />
              Export CSV
            </button>
          )
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[16rem] flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-taupe"
            strokeWidth={1.5}
            aria-hidden
          />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Order number, email, phone or tracking…"
            className="input pl-9"
            aria-label="Search orders"
          />
        </div>

        <select
          value={params.get('status') ?? ''}
          onChange={(event) => setFilter('status', event.target.value)}
          className="input w-auto"
          aria-label="Filter by order status"
        >
          <option value="">All statuses</option>
          {STATUSES.map((status) => (
            <option key={status} value={status}>
              {status.charAt(0) + status.slice(1).toLowerCase()}
            </option>
          ))}
        </select>

        <select
          value={params.get('paymentStatus') ?? ''}
          onChange={(event) => setFilter('paymentStatus', event.target.value)}
          className="input w-auto"
          aria-label="Filter by payment status"
        >
          <option value="">Any payment</option>
          <option value="UNPAID">Unpaid (cash on delivery)</option>
          <option value="PAID">Paid</option>
          <option value="REFUNDED">Refunded</option>
        </select>

        <input
          type="date"
          value={params.get('from') ?? ''}
          onChange={(event) => setFilter('from', event.target.value)}
          className="input w-auto"
          aria-label="From date"
        />
        <input
          type="date"
          value={params.get('to') ?? ''}
          onChange={(event) => setFilter('to', event.target.value)}
          className="input w-auto"
          aria-label="To date"
        />
      </div>

      <Card>
        {isLoading ? (
          <LoadingBlock rows={8} />
        ) : error ? (
          <ErrorState error={error} retry={() => void refetch()} />
        ) : !data?.rows.length ? (
          <EmptyState
            icon={<ShoppingBag className="h-6 w-6" strokeWidth={1} />}
            title="No orders match"
            description="Try widening the filters or clearing the date range."
          />
        ) : (
          <>
            {data.meta?.sumTotal !== undefined && (
              <p className="border-b border-line bg-cream/30 px-4 py-2.5 text-xs text-mocha">
                {data.meta.total} orders · {formatPrice(data.meta.sumTotal as number)} total value
              </p>
            )}

            <div className="overflow-x-auto">
              <table className="w-full min-w-[52rem]">
                <thead>
                  <tr>
                    <th className="th">Order</th>
                    <th className="th">Customer</th>
                    <th className="th">Items</th>
                    <th className="th">Payment</th>
                    <th className="th">Status</th>
                    <th className="th text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((order) => (
                    <tr key={order.id} className="transition-colors hover:bg-cream/40">
                      <td className="td">
                        <Link
                          to={`/orders/${order.id}`}
                          className="text-charcoal transition-colors hover:text-gold"
                        >
                          {order.orderNumber}
                        </Link>
                        <span className="mt-0.5 block text-[0.6875rem] text-taupe">
                          {relativeTime(order.placedAt)}
                        </span>
                      </td>

                      <td className="td">
                        <span className="block max-w-[14rem] truncate text-charcoal">
                          {order.user
                            ? `${order.user.firstName} ${order.user.lastName}`
                            : 'Guest'}
                        </span>
                        <span className="block max-w-[14rem] truncate text-[0.6875rem] text-taupe">
                          {order.email}
                        </span>
                      </td>

                      <td className="td text-mocha">
                        {order.itemCount} item{order.itemCount === 1 ? '' : 's'}
                      </td>

                      <td className="td">
                        {order.paymentStatus ? (
                          <Badge className={PAYMENT_STATUS_TONE[order.paymentStatus]}>
                            {order.paymentStatus}
                          </Badge>
                        ) : (
                          <span className="text-xs text-taupe">—</span>
                        )}
                        {order.paymentMethod && (
                          <span className="mt-0.5 block text-[0.6875rem] text-taupe">
                            {order.paymentMethod}
                          </span>
                        )}
                      </td>

                      <td className="td">
                        <Badge className={ORDER_STATUS_TONE[order.status]}>{order.status}</Badge>
                      </td>

                      <td className="td text-right text-charcoal">{formatPrice(order.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <Pagination
              page={data.meta?.page ?? 1}
              totalPages={data.meta?.totalPages ?? 1}
              total={data.meta?.total ?? 0}
              onChange={(next) => {
                const params2 = new URLSearchParams(params)
                params2.set('page', String(next))
                setParams(params2)
                window.scrollTo({ top: 0 })
              }}
            />
          </>
        )}
      </Card>
    </>
  )
}
