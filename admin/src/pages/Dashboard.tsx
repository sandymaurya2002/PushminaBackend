import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Package,
  ShoppingBag,
  TrendingUp,
  Users,
} from 'lucide-react'
import { api } from '@/lib/api'
import { Card, ErrorState, LoadingBlock, PageHeader, Badge } from '@/components/ui'
import {
  cn,
  CURRENCIES,
  CURRENCY_SYMBOL,
  type Currency,
  formatDate,
  formatNumber,
  formatPrice,
  ORDER_STATUS_TONE,
  relativeTime,
  titleCase,
} from '@/lib/utils'

interface DashboardData {
  range: { days: number; since: string; until: string }
  /** Every money figure below is in this currency only; INR and USD are never summed. */
  currency: Currency
  totals: {
    users: number
    newUsers: number
    products: number
    publishedProducts: number
    orders: number
    ordersInRange: number
    subscribers: number
  }
  revenue: {
    gross: number
    refunded: number
    net: number
    changePercent: number | null
    averageOrderValue: number
    ordersChangePercent: number | null
  }
  payments: {
    successful: number
    successfulAmount: number
    pending: number
    pendingAmount: number
    failed: number
    failedAmount: number
    refunded: number
    refundCount: number
    refundAmount: number
    pendingRefunds: number
    pendingRefundAmount: number
  }
  fulfilment: {
    statusCounts: Record<string, number>
    awaitingFulfilment: number
    packed: number
    inTransit: number
    delivered: number
    cancelled: number
    returnRequested: number
    returned: number
    refundPending: number
    refunded: number
  }
  alerts: {
    lowStock: number
    outOfStock: number
    pendingReviews: number
    newContactSubmissions: number
    pendingRefunds: number
    returnRequests: number
  }
  recentRegistrations: Array<{ id: string; name: string; email: string; createdAt: string }>
  chart: Array<{ date: string; revenue: number; orders: number }>
  recentOrders: Array<{
    id: string
    orderNumber: string
    email: string
    status: string
    total: number
    currency: Currency
    placedAt: string
    items: Array<{ name: string; quantity: number }>
  }>
  recentNotifications: Array<{ id: string; title: string; body: string; createdAt: string }>
  trendingProducts: Array<{ slug: string; name: string; price: number; primaryImage?: { url: string } | null }>
  topProducts: Array<{ productId: string | null; name: string; unitsSold: number; revenue: number }>
}

const RANGES = [
  { label: '7 days', value: 7 },
  { label: '30 days', value: 30 },
  { label: '90 days', value: 90 },
  { label: '1 year', value: 365 },
]

function Metric({
  label,
  value,
  sub,
  change,
  icon: Icon,
}: {
  label: string
  value: string
  sub?: string
  change?: number | null
  icon: typeof Users
}) {
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between">
        <p className="eyebrow text-taupe">{label}</p>
        <Icon className="h-4 w-4 text-gold" strokeWidth={1.4} />
      </div>
      <p className="mt-3 font-serif text-3xl text-charcoal">{value}</p>
      <div className="mt-2 flex items-center gap-2">
        {sub && <span className="text-xs text-taupe">{sub}</span>}
        {change !== null && change !== undefined && (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 text-xs',
              change >= 0 ? 'text-success' : 'text-burgundy',
            )}
          >
            {change >= 0 ? (
              <ArrowUpRight className="h-3 w-3" strokeWidth={2} />
            ) : (
              <ArrowDownRight className="h-3 w-3" strokeWidth={2} />
            )}
            {Math.abs(change)}%
          </span>
        )}
      </div>
    </div>
  )
}

export function Dashboard() {
  const [days, setDays] = useState(30)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [currency, setCurrency] = useState<Currency>('INR')
  const custom = Boolean(from || to)

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['dashboard', currency, custom ? { from, to } : { days }],
    queryFn: async () =>
      (
        await api.get<DashboardData>(
          '/admin/dashboard',
          custom ? { from: from || undefined, to: to || undefined, currency } : { days, currency },
        )
      ).data,
  })

  if (isLoading) return <LoadingBlock rows={8} />
  if (error) return <ErrorState error={error} retry={() => void refetch()} />
  if (!data) return null

  const alerts = [
    data.alerts.outOfStock > 0 && {
      tone: 'burgundy' as const,
      text: `${data.alerts.outOfStock} product${data.alerts.outOfStock === 1 ? '' : 's'} out of stock`,
      to: '/products?stock=out',
    },
    data.alerts.lowStock > 0 && {
      tone: 'gold' as const,
      text: `${data.alerts.lowStock} product${data.alerts.lowStock === 1 ? '' : 's'} low on stock`,
      to: '/products?stock=low',
    },
    data.alerts.pendingRefunds > 0 && {
      tone: 'burgundy' as const,
      text: `${data.alerts.pendingRefunds} refund${data.alerts.pendingRefunds === 1 ? '' : 's'} awaiting approval`,
      to: '/refunds',
    },
    data.alerts.returnRequests > 0 && {
      tone: 'gold' as const,
      text: `${data.alerts.returnRequests} return request${data.alerts.returnRequests === 1 ? '' : 's'}`,
      to: '/orders?status=RETURN_REQUESTED',
    },
    data.fulfilment.awaitingFulfilment > 0 && {
      tone: 'gold' as const,
      text: `${data.fulfilment.awaitingFulfilment} order${data.fulfilment.awaitingFulfilment === 1 ? '' : 's'} to process`,
      to: '/orders?status=PAID',
    },
    data.alerts.pendingReviews > 0 && {
      tone: 'gold' as const,
      text: `${data.alerts.pendingReviews} review${data.alerts.pendingReviews === 1 ? '' : 's'} awaiting moderation`,
      to: '/reviews',
    },
    data.alerts.newContactSubmissions > 0 && {
      tone: 'gold' as const,
      text: `${data.alerts.newContactSubmissions} new enquir${data.alerts.newContactSubmissions === 1 ? 'y' : 'ies'}`,
      to: '/contact',
    },
  ].filter(Boolean) as Array<{ tone: 'gold' | 'burgundy'; text: string; to: string }>

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={
          custom
            ? `Performance from ${formatDate(data.range.since)} to ${formatDate(data.range.until)}.`
            : `Performance for the last ${days} days.`
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex border border-line-strong" role="group" aria-label="Currency">
              {CURRENCIES.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setCurrency(option)}
                  className={cn(
                    'px-3 py-2 text-[0.6875rem] uppercase tracking-[0.1em] transition-colors',
                    currency === option ? 'bg-charcoal text-ivory' : 'text-charcoal hover:bg-cream',
                  )}
                >
                  {CURRENCY_SYMBOL[option]} {option}
                </button>
              ))}
            </div>
            <div className="flex border border-line-strong">
              {RANGES.map((range) => (
                <button
                  key={range.value}
                  type="button"
                  onClick={() => {
                    setFrom('')
                    setTo('')
                    setDays(range.value)
                  }}
                  className={cn(
                    'px-3 py-2 text-[0.6875rem] uppercase tracking-[0.1em] transition-colors',
                    !custom && days === range.value
                      ? 'bg-charcoal text-ivory'
                      : 'text-charcoal hover:bg-cream',
                  )}
                >
                  {range.label}
                </button>
              ))}
            </div>
            <input
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              className="input w-auto"
              aria-label="From date"
            />
            <input
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              className="input w-auto"
              aria-label="To date"
            />
          </div>
        }
      />

      {alerts.length > 0 && (
        <div className="mb-6 flex flex-wrap gap-2">
          {alerts.map((alert) => (
            <Link
              key={alert.to + alert.text}
              to={alert.to}
              className={cn(
                'inline-flex items-center gap-2 border px-3 py-2 text-xs transition-colors',
                alert.tone === 'burgundy'
                  ? 'border-burgundy/30 bg-burgundy/5 text-burgundy hover:bg-burgundy/10'
                  : 'border-gold/40 bg-gold/5 text-gold hover:bg-gold/10',
              )}
            >
              <AlertTriangle className="h-3.5 w-3.5" strokeWidth={1.5} />
              {alert.text}
            </Link>
          ))}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric
          label="Net revenue"
          value={formatPrice(data.revenue.net, data.currency)}
          sub={data.revenue.refunded > 0 ? `${formatPrice(data.revenue.refunded, data.currency)} refunded` : 'after refunds'}
          change={data.revenue.changePercent}
          icon={TrendingUp}
        />
        <Metric
          label="Orders"
          value={formatNumber(data.totals.ordersInRange)}
          sub={`${formatNumber(data.totals.orders)} all time`}
          change={data.revenue.ordersChangePercent}
          icon={ShoppingBag}
        />
        <Metric
          label="Customers"
          value={formatNumber(data.totals.users)}
          sub={`${data.totals.newUsers} new`}
          icon={Users}
        />
        <Metric
          label="Average order"
          value={formatPrice(data.revenue.averageOrderValue, data.currency)}
          sub={`${data.totals.publishedProducts} of ${data.totals.products} published`}
          icon={Package}
        />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <Card title="Revenue" className="xl:col-span-2">
          {data.chart.length === 0 ? (
            <p className="px-5 py-16 text-center text-sm text-taupe">
              No captured payments in this period yet.
            </p>
          ) : (
            <div className="h-72 p-4">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data.chart} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="revenueFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#b08d4f" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="#b08d4f" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="#e4ddd1" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 11, fill: '#a2917a' }}
                    tickLine={false}
                    axisLine={{ stroke: '#e4ddd1' }}
                    tickFormatter={(value: string) => formatDate(value).slice(0, 6)}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: '#a2917a' }}
                    tickLine={false}
                    axisLine={false}
                    width={70}
                    tickFormatter={(value: number) => `${CURRENCY_SYMBOL[data.currency]}${formatNumber(value)}`}
                  />
                  <Tooltip
                    contentStyle={{
                      background: '#fff',
                      border: '1px solid #e4ddd1',
                      borderRadius: 0,
                      fontSize: 12,
                    }}
                    formatter={(value: number, name: string) =>
                      name === 'revenue' ? [formatPrice(value, data.currency), 'Revenue'] : [value, 'Orders']
                    }
                    labelFormatter={(value: string) => formatDate(value)}
                  />
                  <Area
                    type="monotone"
                    dataKey="revenue"
                    stroke="#b08d4f"
                    strokeWidth={2}
                    fill="url(#revenueFill)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        <Card
          title="Payments"
          actions={
            <Link to="/payments" className="text-[0.6875rem] uppercase tracking-[0.12em] text-taupe hover:text-charcoal">
              View all
            </Link>
          }
        >
          <dl className="divide-y divide-line">
            {[
              ['Successful', data.payments.successful, data.payments.successfulAmount, 'text-success'],
              ['Pending', data.payments.pending, data.payments.pendingAmount, 'text-gold'],
              ['Failed', data.payments.failed, data.payments.failedAmount, 'text-burgundy'],
              ['Refunded', data.payments.refunded, data.payments.refundAmount, 'text-burgundy'],
              ['Refunds awaiting approval', data.payments.pendingRefunds, data.payments.pendingRefundAmount, 'text-gold'],
            ].map(([label, count, amount, tone]) => (
              <div key={label as string} className="flex items-center justify-between gap-3 px-5 py-3">
                <dt className="text-sm text-mocha">{label as string}</dt>
                <dd className="text-right">
                  <span className={cn('font-serif text-lg', tone as string)}>{count as number}</span>
                  <span className="ml-2 text-xs text-taupe">{formatPrice(amount as number, data.currency)}</span>
                </dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>

      <Card title="Fulfilment" className="mt-6">
        <div className="grid grid-cols-2 divide-line sm:grid-cols-4 xl:grid-cols-8">
          {[
            ['To process', data.fulfilment.awaitingFulfilment, '/orders?status=PAID'],
            ['Packed', data.fulfilment.packed, '/orders?status=PACKED'],
            ['In transit', data.fulfilment.inTransit, '/orders?status=SHIPPED'],
            ['Delivered', data.fulfilment.delivered, '/orders?status=DELIVERED'],
            ['Return requests', data.fulfilment.returnRequested, '/orders?status=RETURN_REQUESTED'],
            ['Returned', data.fulfilment.returned, '/orders?status=RETURNED'],
            ['Refund pending', data.fulfilment.refundPending, '/orders?status=REFUND_PENDING'],
            ['Cancelled', data.fulfilment.cancelled, '/orders?status=CANCELLED'],
          ].map(([label, count, to]) => (
            <Link
              key={label as string}
              to={to as string}
              className="border-b border-r border-line px-5 py-4 transition-colors hover:bg-cream/40"
            >
              <p className="eyebrow text-taupe">{label as string}</p>
              <p className="mt-1.5 font-serif text-2xl text-charcoal">{formatNumber(count as number)}</p>
            </Link>
          ))}
        </div>
        <p className="px-5 py-3 text-[0.6875rem] text-taupe">
          Orders placed in this period, by their current status.
        </p>
      </Card>

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <Card
          title="Recent orders"
          className="xl:col-span-2"
          actions={
            <Link to="/orders" className="text-[0.6875rem] uppercase tracking-[0.12em] text-taupe hover:text-charcoal">
              View all
            </Link>
          }
        >
          {data.recentOrders.length === 0 ? (
            <p className="px-5 py-12 text-center text-sm text-taupe">No orders yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[34rem]">
                <thead>
                  <tr>
                    <th className="th">Order</th>
                    <th className="th">Customer</th>
                    <th className="th">Status</th>
                    <th className="th text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentOrders.map((order) => (
                    <tr key={order.id} className="transition-colors hover:bg-cream/40">
                      <td className="td">
                        <Link to={`/orders/${order.id}`} className="text-charcoal hover:text-gold">
                          {order.orderNumber}
                        </Link>
                        <span className="mt-0.5 block text-[0.6875rem] text-taupe">
                          {relativeTime(order.placedAt)}
                        </span>
                      </td>
                      <td className="td">
                        <span className="block truncate text-xs text-mocha">{order.email}</span>
                      </td>
                      <td className="td">
                        <Badge className={ORDER_STATUS_TONE[order.status]}>{titleCase(order.status)}</Badge>
                      </td>
                      <td className="td text-right text-charcoal">{formatPrice(order.total, order.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Best sellers">
          {data.topProducts.length === 0 ? (
            <p className="px-5 py-12 text-center text-sm text-taupe">
              No sales in this period yet.
            </p>
          ) : (
            <ol className="divide-y divide-line">
              {data.topProducts.map((product, index) => (
                <li key={product.productId ?? index} className="flex items-center gap-3 px-5 py-3">
                  <span className="font-serif text-lg text-taupe">{index + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-charcoal">{product.name}</span>
                    <span className="block text-[0.6875rem] text-taupe">
                      {product.unitsSold} sold · {formatPrice(product.revenue, data.currency)}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>

      <Card
        title="New customers"
        className="mt-6"
        actions={
          <Link to="/customers" className="text-[0.6875rem] uppercase tracking-[0.12em] text-taupe hover:text-charcoal">
            View all
          </Link>
        }
      >
        {data.recentRegistrations.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-taupe">No registrations in this period.</p>
        ) : (
          <ul className="divide-y divide-line">
            {data.recentRegistrations.map((customer) => (
              <li key={customer.id} className="flex items-center gap-3 px-5 py-3">
                <Link to={`/customers/${customer.id}`} className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-charcoal hover:text-gold">{customer.name}</span>
                  <span className="block truncate text-[0.6875rem] text-taupe">{customer.email}</span>
                </Link>
                <span className="shrink-0 text-[0.6875rem] text-taupe">{relativeTime(customer.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  )
}
