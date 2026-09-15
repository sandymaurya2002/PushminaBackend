import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MessageSquare } from 'lucide-react'
import { api, type ApiMeta } from '@/lib/api'
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  LoadingBlock,
  Modal,
  PageHeader,
  Pagination,
  useToast,
} from '@/components/ui'
import { useAuth } from '@/lib/auth'
import { formatDateTime } from '@/lib/utils'

interface Submission {
  id: string
  name: string
  email: string
  phone: string | null
  subject: string
  message: string
  status: string
  adminNotes: string | null
  createdAt: string
}

const TONE: Record<string, string> = {
  NEW: 'border-gold/50 text-gold',
  READ: 'border-line-strong text-mocha',
  REPLIED: 'border-success/40 text-success',
  CLOSED: 'border-line-strong text-taupe',
}

export function Contact() {
  const [params, setParams] = useSearchParams()
  const { can } = useAuth()
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState<Submission | null>(null)
  const [notes, setNotes] = useState('')

  const filters = {
    status: params.get('status') ?? undefined,
    page: Number(params.get('page') ?? 1),
    limit: 20,
  }

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin-contact', filters],
    queryFn: async () => {
      const result = await api.get<Submission[]>('/admin/contact', filters)
      return { rows: result.data, meta: result.meta as ApiMeta }
    },
  })

  const update = useMutation({
    mutationFn: async ({ id, ...body }: { id: string; status?: string; adminNotes?: string }) =>
      api.patch(`/admin/contact/${id}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-contact'] })
      void queryClient.invalidateQueries({ queryKey: ['sidebar-counts'] })
      setOpen(null)
      toast({ title: 'Enquiry updated' })
    },
  })

  return (
    <>
      <PageHeader
        title="Enquiries"
        description="Messages sent through the contact form on the website."
      />

      <div className="mb-4 flex flex-wrap gap-1">
        {['', 'NEW', 'READ', 'REPLIED', 'CLOSED'].map((status) => (
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
            icon={<MessageSquare className="h-6 w-6" strokeWidth={1} />}
            title="No enquiries"
            description="Messages from the contact form appear here."
          />
        ) : (
          <>
            <ul className="divide-y divide-line">
              {data.rows.map((submission) => (
                <li key={submission.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(submission)
                      setNotes(submission.adminNotes ?? '')
                      if (submission.status === 'NEW' && can('contact.update')) {
                        update.mutate({ id: submission.id, status: 'READ' })
                      }
                    }}
                    className="w-full px-5 py-4 text-left transition-colors hover:bg-cream/40"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm text-charcoal">{submission.subject}</span>
                      <Badge className={TONE[submission.status]}>{submission.status}</Badge>
                    </div>
                    <p className="mt-1 line-clamp-2 max-w-3xl text-sm text-mocha">
                      {submission.message}
                    </p>
                    <p className="mt-1.5 text-[0.6875rem] text-taupe">
                      {submission.name} · {submission.email} ·{' '}
                      {formatDateTime(submission.createdAt)}
                    </p>
                  </button>
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

      <Modal
        open={Boolean(open)}
        onClose={() => setOpen(null)}
        title={open?.subject ?? ''}
        wide
        footer={
          can('contact.update') && (
            <>
              <button
                type="button"
                onClick={() =>
                  open && update.mutate({ id: open.id, status: 'CLOSED', adminNotes: notes })
                }
                className="btn-ghost"
              >
                Close enquiry
              </button>
              <button
                type="button"
                onClick={() =>
                  open && update.mutate({ id: open.id, status: 'REPLIED', adminNotes: notes })
                }
                className="btn-primary"
              >
                Mark replied
              </button>
            </>
          )
        }
      >
        {open && (
          <div className="space-y-5">
            <dl className="grid gap-3 sm:grid-cols-2">
              <div>
                <dt className="eyebrow text-taupe">From</dt>
                <dd className="mt-0.5 text-sm text-charcoal">{open.name}</dd>
              </div>
              <div>
                <dt className="eyebrow text-taupe">Email</dt>
                <dd className="mt-0.5 break-all text-sm">
                  <a href={`mailto:${open.email}`} className="text-charcoal hover:text-gold">
                    {open.email}
                  </a>
                </dd>
              </div>
              {open.phone && (
                <div>
                  <dt className="eyebrow text-taupe">Phone</dt>
                  <dd className="mt-0.5 text-sm text-charcoal">{open.phone}</dd>
                </div>
              )}
              <div>
                <dt className="eyebrow text-taupe">Received</dt>
                <dd className="mt-0.5 text-sm text-charcoal">{formatDateTime(open.createdAt)}</dd>
              </div>
            </dl>

            <div>
              <p className="eyebrow mb-2 text-taupe">Message</p>
              <p className="whitespace-pre-wrap border border-line bg-cream/30 p-4 text-sm leading-relaxed text-mocha">
                {open.message}
              </p>
            </div>

            {can('contact.update') && (
              <div>
                <label htmlFor="admin-notes" className="label">
                  Internal notes
                </label>
                <textarea
                  id="admin-notes"
                  rows={3}
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  className="input h-auto py-2"
                  placeholder="Not visible to the customer."
                />
              </div>
            )}
          </div>
        )}
      </Modal>
    </>
  )
}
