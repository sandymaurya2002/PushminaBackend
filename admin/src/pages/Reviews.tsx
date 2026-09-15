import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Star, Trash2 } from 'lucide-react'
import { api, ApiError, type ApiMeta } from '@/lib/api'
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

interface ReviewRow {
  id: string
  rating: number
  title: string
  body: string
  authorName: string
  isVerifiedPurchase: boolean
  status: string
  adminReply: string | null
  createdAt: string
  product: { id: string; slug: string; name: string }
  user: { id: string; email: string } | null
}

const TONE: Record<string, string> = {
  PENDING: 'border-gold/50 text-gold',
  APPROVED: 'border-success/40 text-success',
  REJECTED: 'border-burgundy/40 text-burgundy',
}

export function Reviews() {
  const [params, setParams] = useSearchParams()
  const { can } = useAuth()
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const filters = {
    status: params.get('status') ?? undefined,
    page: Number(params.get('page') ?? 1),
    limit: 20,
  }

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin-reviews', filters],
    queryFn: async () => {
      const result = await api.get<ReviewRow[]>('/admin/reviews', filters)
      return { rows: result.data, meta: result.meta as ApiMeta }
    },
  })

  const moderate = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) =>
      api.patch(`/admin/reviews/${id}`, { status }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-reviews'] })
      void queryClient.invalidateQueries({ queryKey: ['sidebar-counts'] })
      toast({
        title: 'Review updated',
        description: 'The product rating has been recalculated.',
      })
    },
    onError: (caught) =>
      toast({
        title: 'Could not update',
        description: caught instanceof ApiError ? caught.message : 'Unexpected error.',
        tone: 'error',
      }),
  })

  const remove = useMutation({
    mutationFn: async (id: string) => api.delete(`/admin/reviews/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-reviews'] })
      toast({ title: 'Review deleted' })
    },
  })

  const pending = (data?.meta?.pendingCount ?? 0) as number

  return (
    <>
      <PageHeader
        title="Reviews"
        description="Reviews are held for moderation before they appear on the website or feed structured data."
      />

      <div className="mb-4 flex flex-wrap gap-1">
        {['', 'PENDING', 'APPROVED', 'REJECTED'].map((status) => (
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
            {status === 'PENDING' && pending > 0 && ` (${pending})`}
          </button>
        ))}
      </div>

      <Card>
        {isLoading ? (
          <LoadingBlock rows={6} />
        ) : error ? (
          <ErrorState error={error} retry={() => void refetch()} />
        ) : !data?.rows.length ? (
          <EmptyState
            icon={<Star className="h-6 w-6" strokeWidth={1} />}
            title="No reviews"
            description="Customer reviews will appear here for approval."
          />
        ) : (
          <>
            <ul className="divide-y divide-line">
              {data.rows.map((review) => (
                <li key={review.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm text-gold" aria-label={`${review.rating} stars`}>
                          {'★'.repeat(review.rating)}
                          <span className="text-line-strong">
                            {'★'.repeat(5 - review.rating)}
                          </span>
                        </span>
                        <span className="text-sm text-charcoal">{review.title}</span>
                        <Badge className={TONE[review.status]}>{review.status}</Badge>
                        {review.isVerifiedPurchase && (
                          <Badge className="border-success/40 text-success">Verified</Badge>
                        )}
                      </div>

                      <p className="mt-2 max-w-3xl text-sm leading-relaxed text-mocha">
                        {review.body}
                      </p>

                      <p className="mt-2 text-[0.6875rem] text-taupe">
                        {review.authorName} · {review.product.name} ·{' '}
                        {formatDate(review.createdAt)}
                      </p>
                    </div>

                    <div className="flex shrink-0 gap-1.5">
                      {can('reviews.moderate') && review.status !== 'APPROVED' && (
                        <button
                          type="button"
                          onClick={() => moderate.mutate({ id: review.id, status: 'APPROVED' })}
                          className="btn-primary btn-sm"
                        >
                          Approve
                        </button>
                      )}
                      {can('reviews.moderate') && review.status !== 'REJECTED' && (
                        <button
                          type="button"
                          onClick={() => moderate.mutate({ id: review.id, status: 'REJECTED' })}
                          className="btn-outline btn-sm"
                        >
                          Reject
                        </button>
                      )}
                      {can('reviews.delete') && (
                        <button
                          type="button"
                          onClick={() => remove.mutate(review.id)}
                          aria-label="Delete review"
                          className="p-1.5 text-taupe transition-colors hover:text-burgundy"
                        >
                          <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>

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
