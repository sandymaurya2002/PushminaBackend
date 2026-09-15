import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Download, Search, Users } from 'lucide-react'
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
import { formatDate, formatPrice } from '@/lib/utils'

interface CustomerRow {
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
  orderCount: number
  reviewCount: number
  wishlistCount: number
  lifetimeSpend: number
}

export function Customers() {
  const [params, setParams] = useSearchParams()
  const { can } = useAuth()
  const { toast } = useToast()
  const [search, setSearch] = useState(params.get('q') ?? '')

  const filters = {
    q: params.get('q') ?? undefined,
    status: params.get('status') ?? undefined,
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
    queryKey: ['admin-customers', filters],
    queryFn: async () => {
      const result = await api.get<CustomerRow[]>('/admin/customers', filters)
      return { rows: result.data, meta: result.meta as ApiMeta }
    },
  })

  return (
    <>
      <PageHeader
        title="Customers"
        description="Everyone with an account, their order history and lifetime value."
        actions={
          can('customers.export') && (
            <button
              type="button"
              onClick={async () => {
                try {
                  await api.download('/admin/customers/export/csv')
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
            placeholder="Name, email or phone…"
            className="input pl-9"
            aria-label="Search customers"
          />
        </div>

        <select
          value={params.get('status') ?? ''}
          onChange={(event) => {
            const next = new URLSearchParams(params)
            if (event.target.value) next.set('status', event.target.value)
            else next.delete('status')
            next.delete('page')
            setParams(next)
          }}
          className="input w-auto"
          aria-label="Filter by status"
        >
          <option value="">Active accounts</option>
          <option value="ACTIVE">Active</option>
          <option value="BLOCKED">Blocked</option>
        </select>

        <select
          value={params.get('sort') ?? 'newest'}
          onChange={(event) => {
            const next = new URLSearchParams(params)
            next.set('sort', event.target.value)
            setParams(next)
          }}
          className="input w-auto"
          aria-label="Sort"
        >
          <option value="newest">Newest</option>
          <option value="oldest">Oldest</option>
          <option value="name">Name</option>
          <option value="spend">Lifetime spend</option>
        </select>
      </div>

      <Card>
        {isLoading ? (
          <LoadingBlock rows={8} />
        ) : error ? (
          <ErrorState error={error} retry={() => void refetch()} />
        ) : !data?.rows.length ? (
          <EmptyState
            icon={<Users className="h-6 w-6" strokeWidth={1} />}
            title="No customers match"
            description="Customers appear here once they create an account."
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[48rem]">
                <thead>
                  <tr>
                    <th className="th">Customer</th>
                    <th className="th">Joined</th>
                    <th className="th text-right">Orders</th>
                    <th className="th text-right">Lifetime spend</th>
                    <th className="th">Marketing</th>
                    <th className="th">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((customer) => (
                    <tr key={customer.id} className="transition-colors hover:bg-cream/40">
                      <td className="td">
                        <Link
                          to={`/customers/${customer.id}`}
                          className="text-charcoal transition-colors hover:text-gold"
                        >
                          {customer.firstName} {customer.lastName}
                        </Link>
                        <span className="mt-0.5 block max-w-[16rem] truncate text-[0.6875rem] text-taupe">
                          {customer.email}
                        </span>
                      </td>

                      <td className="td text-xs text-mocha">{formatDate(customer.createdAt)}</td>

                      <td className="td text-right tabular-nums text-mocha">
                        {customer.orderCount}
                      </td>

                      <td className="td text-right text-charcoal">
                        {formatPrice(customer.lifetimeSpend)}
                      </td>

                      <td className="td">
                        <span className="text-xs text-taupe">
                          {customer.acceptsMarketing ? 'Opted in' : '—'}
                        </span>
                      </td>

                      <td className="td">
                        <Badge
                          className={
                            customer.status === 'ACTIVE'
                              ? 'border-success/40 text-success'
                              : 'border-burgundy/40 text-burgundy'
                          }
                        >
                          {customer.status}
                        </Badge>
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
              }}
            />
          </>
        )}
      </Card>
    </>
  )
}
