import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Newspaper, Plus, Trash2 } from 'lucide-react'
import { api, ApiError, type ApiMeta } from '@/lib/api'
import {
  Badge,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LoadingBlock,
  PageHeader,
  Pagination,
} from '@/components/ui'
import { useToast } from '@/components/ui'
import { useAuth } from '@/lib/auth'
import { formatDate, PRODUCT_STATUS_TONE } from '@/lib/utils'

interface PostRow {
  id: string
  slug: string
  title: string
  excerpt: string
  status: string
  publishedAt: string | null
  scheduledAt: string | null
  coverUrl: string | null
  readingMinutes: number
  viewCount: number
  authorName: string
  category: { id: string; name: string }
}

export function Blog() {
  const [params, setParams] = useSearchParams()
  const { can } = useAuth()
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [deleting, setDeleting] = useState<PostRow | null>(null)

  const filters = {
    status: params.get('status') ?? undefined,
    page: Number(params.get('page') ?? 1),
    limit: 20,
  }

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin-posts', filters],
    queryFn: async () => {
      const result = await api.get<PostRow[]>('/admin/blog/posts', filters)
      return { rows: result.data, meta: result.meta as ApiMeta }
    },
  })

  const remove = useMutation({
    mutationFn: async (id: string) => api.delete(`/admin/blog/posts/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-posts'] })
      setDeleting(null)
      toast({ title: 'Article deleted' })
    },
    onError: (caught) => {
      setDeleting(null)
      toast({
        title: 'Could not delete',
        description: caught instanceof ApiError ? caught.message : 'Unexpected error.',
        tone: 'error',
      })
    },
  })

  return (
    <>
      <PageHeader
        title="Journal"
        description="Guides and editorial. Articles can be published immediately or scheduled for a future date."
        actions={
          can('blog.create') && (
            <Link to="/blog/new" className="btn-primary">
              <Plus className="h-3.5 w-3.5" strokeWidth={2} />
              New article
            </Link>
          )
        }
      />

      <div className="mb-4 flex flex-wrap gap-1">
        {['', 'PUBLISHED', 'SCHEDULED', 'DRAFT', 'ARCHIVED'].map((status) => (
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
          <LoadingBlock rows={6} />
        ) : error ? (
          <ErrorState error={error} retry={() => void refetch()} />
        ) : !data?.rows.length ? (
          <EmptyState
            icon={<Newspaper className="h-6 w-6" strokeWidth={1} />}
            title="No articles"
            description="Write the first one and it will appear in the journal on the website."
          />
        ) : (
          <>
            <ul className="divide-y divide-line">
              {data.rows.map((post) => (
                <li key={post.id} className="flex items-center gap-4 px-5 py-4">
                  <div className="h-16 w-24 shrink-0 overflow-hidden bg-ivory-deep">
                    {post.coverUrl && (
                      <img src={post.coverUrl} alt="" className="h-full w-full object-cover" />
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        to={`/blog/${post.id}`}
                        className="truncate text-sm text-charcoal transition-colors hover:text-gold"
                      >
                        {post.title}
                      </Link>
                      <Badge className={PRODUCT_STATUS_TONE[post.status]}>{post.status}</Badge>
                    </div>

                    <p className="mt-1 line-clamp-1 text-xs text-mocha">{post.excerpt}</p>

                    <p className="mt-1.5 text-[0.6875rem] text-taupe">
                      {post.category.name} · {post.authorName} · {post.readingMinutes} min
                      {post.status === 'SCHEDULED' && post.scheduledAt
                        ? ` · scheduled for ${formatDate(post.scheduledAt)}`
                        : post.publishedAt
                          ? ` · ${formatDate(post.publishedAt)}`
                          : ''}
                      {post.viewCount > 0 && ` · ${post.viewCount} views`}
                    </p>
                  </div>

                  {can('blog.delete') && (
                    <button
                      type="button"
                      onClick={() => setDeleting(post)}
                      aria-label={`Delete ${post.title}`}
                      className="shrink-0 p-1.5 text-taupe transition-colors hover:text-burgundy"
                    >
                      <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                    </button>
                  )}
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

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
        busy={remove.isPending}
        title={`Delete "${deleting?.title}"?`}
        message="The article is removed from the website permanently. Consider archiving it instead if it might return."
      />
    </>
  )
}
