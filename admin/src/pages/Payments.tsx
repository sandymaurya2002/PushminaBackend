import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { CreditCard, Download, Search } from 'lucide-react'
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
import { type Currency, formatDateTime, formatPrice, PAYMENT_STATUS_TONE } from '@/lib/utils'

interface PaymentRow {
  id: string
  status: string
  method: string
  amount: number
  amountRefunded: number
  currency: Currency
  provider: string
  providerPaymentId: string | null
  providerOrderId: string | null
  failureReason: string | null
  createdAt: string
  capturedAt: string | null
  order: {
    id: string
    orderNumber: string
    email: string
    status: string
    user: { id: string; firstName: string; lastName: string } | null
  }
  refunds: Array<{ id: string; amount: number; status: string }>
}

export function Payments() {
  const [params, setParams] = useSearchParams()
  const { can } = useAuth()
  const { toast } = useToast()
  const [search, setSearch] = useState(params.get('q') ?? '')

  const filters = {
    q: params.get('q') ?? undefined,
    status: params.get('status') ?? undefined,
    method: params.get('method') ?? undefined,
    currency: params.get('currency') ?? undefined,
    from: params.get('from') ?? undefined,
    to: params.get('to') ?? undefined,
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
    queryKey: ['admin-payments', filters],
    queryFn: async () => {
      const result = await api.get<PaymentRow[]>('/admin/payments', filters)
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

  const byStatus = useMemo(() => {
    const entries = (data?.meta?.byStatus ?? []) as Array<{
      status: string
      currency: Currency
      count: number
      amount: number
    }>
    const grouped = new Map<string, { status: string; count: number; amounts: Array<[Currency, number]> }>()
    for (const entry of entries) {
      const group = grouped.get(entry.status) ?? { status: entry.status, count: 0, amounts: [] }
      group.count += entry.count
      group.amounts.push([entry.currency ?? 'INR', entry.amount])
      grouped.set(entry.status, group)
    }
    return [...grouped.values()]
  }, [data?.meta?.byStatus])

  return (
    <>
      <PageHeader
        title="Payments"
        description="Every transaction, searchable by transaction id, gateway order id, order number or customer email."
        actions={
          can('payments.export') && (
            <button
              type="button"
              onClick={async () => {
                try {
                  await api.download('/admin/payments/export/csv', filters)
                  toast({ title: 'Export started' })
                } catch {
                  toast({ title: 'Export failed', tone: 'error' })
                }
              }}
              className="btn-outline"
            >
              <Download className="h-3.5 w-3.5" strokeWidth={1.5} />
              Export CSV
            </button>
          )
        }
      />

      {byStatus.length > 0 && (
        <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {byStatus.map((entry) => (
            <button
              key={entry.status}
              type="button"
              onClick={() =>
                setFilter('status', params.get('status') === entry.status ? '' : entry.status)
              }
              className={`card p-4 text-left transition-colors hover:border-charcoal ${
                params.get('status') === entry.status ? 'border-charcoal' : ''
              }`}
            >
              <p className="eyebrow text-taupe">{entry.status.replace(/_/g, ' ')}</p>
              <p className="mt-2 font-serif text-2xl text-charcoal">{entry.count}</p>
              <p className="mt-1 text-xs text-mocha">
                {entry.amounts.map(([currency, amount]) => formatPrice(amount, currency)).join(' · ')}
              </p>
            </button>
          ))}
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[18rem] flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-taupe"
            strokeWidth={1.5}
            aria-hidden
          />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Transaction id, order number or email…"
            className="input pl-9"
            aria-label="Search payments"
          />
        </div>

        <select
          value={params.get('method') ?? ''}
          onChange={(event) => setFilter('method', event.target.value)}
          className="input w-auto"
          aria-label="Filter by method"
        >
          <option value="">Any method</option>
          {['UPI', 'CARD', 'NETBANKING', 'WALLET', 'COD', 'OTHER'].map((method) => (
            <option key={method} value={method}>
              {method}
            </option>
          ))}
        </select>

        <select
          value={params.get('currency') ?? ''}
          onChange={(event) => setFilter('currency', event.target.value)}
          className="input w-auto"
          aria-label="Filter by currency"
        >
          <option value="">All currencies</option>
          <option value="INR">₹ INR</option>
          <option value="USD">$ USD</option>
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
            icon={<CreditCard className="h-6 w-6" strokeWidth={1} />}
            title="No payments match"
            description="Try clearing the filters or widening the date range."
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[56rem]">
                <thead>
                  <tr>
                    <th className="th">Transaction</th>
                    <th className="th">Order</th>
                    <th className="th">Customer</th>
                    <th className="th">Method</th>
                    <th className="th">Status</th>
                    <th className="th text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((payment) => (
                    <tr key={payment.id} className="transition-colors hover:bg-cream/40">
                      <td className="td">
                        <code className="text-[0.6875rem] text-mocha">
                          {payment.providerPaymentId ?? payment.providerOrderId ?? payment.id}
                        </code>
                        <span className="mt-0.5 block text-[0.6875rem] text-taupe">
                          {formatDateTime(payment.capturedAt ?? payment.createdAt)}
                        </span>
                      </td>

                      <td className="td">
                        <Link
                          to={`/orders/${payment.order.id}`}
                          className="text-charcoal hover:text-gold"
                        >
                          {payment.order.orderNumber}
                        </Link>
                      </td>

                      <td className="td">
                        <span className="block max-w-[13rem] truncate text-xs text-mocha">
                          {payment.order.user
                            ? `${payment.order.user.firstName} ${payment.order.user.lastName}`
                            : payment.order.email}
                        </span>
                      </td>

                      <td className="td text-mocha">{payment.method}</td>

                      <td className="td">
                        <Badge className={PAYMENT_STATUS_TONE[payment.status]}>
                          {payment.status.replace(/_/g, ' ')}
                        </Badge>
                        {payment.failureReason && (
                          <span className="mt-0.5 block max-w-[12rem] truncate text-[0.6875rem] text-burgundy">
                            {payment.failureReason}
                          </span>
                        )}
                      </td>

                      <td className="td text-right">
                        <span className="text-charcoal">{formatPrice(payment.amount, payment.currency)}</span>
                        {payment.amountRefunded > 0 && (
                          <span className="mt-0.5 block text-[0.6875rem] text-burgundy">
                            −{formatPrice(payment.amountRefunded, payment.currency)} refunded
                          </span>
                        )}
                      </td>
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
