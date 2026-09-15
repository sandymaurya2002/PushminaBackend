import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Download, Mail } from 'lucide-react'
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
import { formatDate } from '@/lib/utils'

interface Subscriber {
  id: string
  email: string
  status: string
  source: string | null
  subscribedAt: string
  unsubscribedAt: string | null
}

export function Newsletter() {
  const [params, setParams] = useSearchParams()
  const { can } = useAuth()
  const { toast } = useToast()

  const filters = {
    status: params.get('status') ?? undefined,
    page: Number(params.get('page') ?? 1),
    limit: 50,
  }

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin-newsletter', filters],
    queryFn: async () => {
      const result = await api.get<Subscriber[]>('/admin/newsletter', filters)
      return { rows: result.data, meta: result.meta as ApiMeta }
    },
  })

  return (
    <>
      <PageHeader
        title="Newsletter"
        description={`${(data?.meta?.activeCount ?? 0) as number} active subscribers.`}
        actions={
          can('newsletter.export') && (
            <button
              type="button"
              onClick={async () => {
                try {
                  await api.download('/admin/newsletter/export/csv')
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

      <div className="mb-4 flex flex-wrap gap-1">
        {['', 'SUBSCRIBED', 'UNSUBSCRIBED'].map((status) => (
          <button
            key={status || 'all'}
            type="button"
            onClick={() => {
              const next = new URLSearchParams(params)
              if (status) next.set('status', status)
              else next.delete('status')
              next.delete('page')
              setParams(next)
            }}
            className={`chip transition-colors ${
              (params.get('status') ?? '') === status
                ? 'border-charcoal bg-charcoal text-ivory'
                : 'border-line-strong text-mocha hover:border-charcoal'
            }`}
          >
            {status || 'All'}
          </button>
        ))}
      </div>

      <Card>
        {isLoading ? (
          <LoadingBlock rows={8} />
        ) : error ? (
          <ErrorState error={error} retry={() => void refetch()} />
        ) : !data?.rows.length ? (
          <EmptyState
            icon={<Mail className="h-6 w-6" strokeWidth={1} />}
            title="No subscribers yet"
            description="Sign-ups from the website footer appear here."
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[36rem]">
                <thead>
                  <tr>
                    <th className="th">Email</th>
                    <th className="th">Source</th>
                    <th className="th">Subscribed</th>
                    <th className="th">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((subscriber) => (
                    <tr key={subscriber.id} className="transition-colors hover:bg-cream/40">
                      <td className="td text-charcoal">{subscriber.email}</td>
                      <td className="td text-mocha">{subscriber.source ?? '—'}</td>
                      <td className="td text-xs text-mocha">
                        {formatDate(subscriber.subscribedAt)}
                      </td>
                      <td className="td">
                        <Badge
                          className={
                            subscriber.status === 'SUBSCRIBED'
                              ? 'border-success/40 text-success'
                              : 'border-line-strong text-taupe'
                          }
                        >
                          {subscriber.status}
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
