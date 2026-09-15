import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RotateCcw } from 'lucide-react'
import { api, ApiError, type ApiMeta } from '@/lib/api'
import {
  Badge,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  LoadingBlock,
  Modal,
  PageHeader,
  Pagination,
  Spinner,
  useToast,
} from '@/components/ui'
import { useAuth } from '@/lib/auth'
import { formatDateTime, formatPrice } from '@/lib/utils'

interface RefundRow {
  id: string
  amount: number
  reason: string | null
  status: string
  notes: string | null
  failureReason: string | null
  createdAt: string
  completedAt: string | null
  order: { id: string; orderNumber: string; email: string }
  requestedBy: { id: string; firstName: string; lastName: string } | null
  processedBy: { id: string; name: string } | null
}

const TONE: Record<string, string> = {
  REQUESTED: 'border-gold/50 text-gold',
  APPROVED: 'border-gold/50 text-gold',
  PROCESSING: 'border-gold/50 text-gold',
  COMPLETED: 'border-success/40 text-success',
  REJECTED: 'border-burgundy/40 text-burgundy',
  FAILED: 'border-burgundy/40 text-burgundy',
}

export function Refunds() {
  const [params, setParams] = useSearchParams()
  const { can } = useAuth()
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const [approving, setApproving] = useState<RefundRow | null>(null)
  const [rejecting, setRejecting] = useState<RefundRow | null>(null)
  const [rejectReason, setRejectReason] = useState('')

  const filters = {
    status: params.get('status') ?? undefined,
    page: Number(params.get('page') ?? 1),
    limit: 25,
  }

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin-refunds', filters],
    queryFn: async () => {
      const result = await api.get<RefundRow[]>('/admin/payments/refunds/all', filters)
      return { rows: result.data, meta: result.meta as ApiMeta }
    },
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin-refunds'] })
    void queryClient.invalidateQueries({ queryKey: ['sidebar-counts'] })
  }

  const approveMutation = useMutation({
    mutationFn: async (id: string) => api.post(`/admin/payments/refunds/${id}/approve`),
    onSuccess: () => {
      invalidate()
      setApproving(null)
      toast({
        title: 'Refund approved',
        description: 'The gateway has been asked to return the money.',
      })
    },
    onError: (caught) => {
      setApproving(null)
      toast({
        title: 'Refund failed',
        description: caught instanceof ApiError ? caught.message : 'Unexpected error.',
        tone: 'error',
      })
    },
  })

  const rejectMutation = useMutation({
    mutationFn: async (id: string) =>
      api.post(`/admin/payments/refunds/${id}/reject`, { reason: rejectReason }),
    onSuccess: () => {
      invalidate()
      setRejecting(null)
      setRejectReason('')
      toast({ title: 'Refund rejected' })
    },
    onError: (caught) =>
      toast({
        title: 'Could not reject',
        description: caught instanceof ApiError ? caught.message : 'Unexpected error.',
        tone: 'error',
      }),
  })

  const pending = (data?.meta?.pendingCount ?? 0) as number

  return (
    <>
      <PageHeader
        title="Refunds"
        description="Requests from customers and staff. Nothing is returned to a card until it is approved here."
      />

      <div className="mb-4 flex flex-wrap gap-1">
        {['', 'REQUESTED', 'PROCESSING', 'COMPLETED', 'REJECTED', 'FAILED'].map((status) => (
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
            {status === 'REQUESTED' && pending > 0 && ` (${pending})`}
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
            icon={<RotateCcw className="h-6 w-6" strokeWidth={1} />}
            title="No refunds"
            description="Refund requests will appear here for approval."
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[52rem]">
                <thead>
                  <tr>
                    <th className="th">Order</th>
                    <th className="th">Reason</th>
                    <th className="th">Requested</th>
                    <th className="th">Status</th>
                    <th className="th text-right">Amount</th>
                    <th className="th w-40 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((refund) => (
                    <tr key={refund.id} className="transition-colors hover:bg-cream/40">
                      <td className="td">
                        <Link
                          to={`/orders/${refund.order.id}`}
                          className="text-charcoal hover:text-gold"
                        >
                          {refund.order.orderNumber}
                        </Link>
                        <span className="mt-0.5 block max-w-[12rem] truncate text-[0.6875rem] text-taupe">
                          {refund.order.email}
                        </span>
                      </td>

                      <td className="td">
                        <span className="block max-w-xs text-xs text-mocha">
                          {refund.reason ?? '—'}
                        </span>
                        {refund.failureReason && (
                          <span className="mt-0.5 block text-[0.6875rem] text-burgundy">
                            {refund.failureReason}
                          </span>
                        )}
                      </td>

                      <td className="td text-[0.6875rem] text-taupe">
                        {formatDateTime(refund.createdAt)}
                        {refund.requestedBy && (
                          <span className="block">
                            by {refund.requestedBy.firstName} {refund.requestedBy.lastName}
                          </span>
                        )}
                      </td>

                      <td className="td">
                        <Badge className={TONE[refund.status]}>{refund.status}</Badge>
                      </td>

                      <td className="td text-right text-charcoal">{formatPrice(refund.amount)}</td>

                      <td className="td">
                        {refund.status === 'REQUESTED' && (
                          <div className="flex justify-end gap-1.5">
                            {can('refunds.approve') && (
                              <button
                                type="button"
                                onClick={() => setApproving(refund)}
                                className="btn-primary btn-sm"
                              >
                                Approve
                              </button>
                            )}
                            {can('refunds.reject') && (
                              <button
                                type="button"
                                onClick={() => setRejecting(refund)}
                                className="btn-outline btn-sm"
                              >
                                Reject
                              </button>
                            )}
                          </div>
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
              }}
            />
          </>
        )}
      </Card>

      <ConfirmDialog
        open={Boolean(approving)}
        onClose={() => setApproving(null)}
        onConfirm={() => approving && approveMutation.mutate(approving.id)}
        busy={approveMutation.isPending}
        danger={false}
        confirmLabel="Approve and refund"
        title="Approve this refund?"
        message={`${formatPrice(approving?.amount ?? 0)} will be returned to the original payment method for order ${approving?.order.orderNumber}. This cannot be undone.`}
      />

      <Modal
        open={Boolean(rejecting)}
        onClose={() => setRejecting(null)}
        title="Reject this refund"
        footer={
          <>
            <button type="button" onClick={() => setRejecting(null)} className="btn-ghost">
              Cancel
            </button>
            <button
              type="button"
              onClick={() => rejecting && rejectMutation.mutate(rejecting.id)}
              disabled={rejectMutation.isPending || rejectReason.trim().length < 3}
              className="btn-danger"
            >
              {rejectMutation.isPending && <Spinner />}
              Reject
            </button>
          </>
        }
      >
        <Field label="Reason" htmlFor="reject-reason" required hint="Recorded against the refund.">
          <textarea
            id="reject-reason"
            rows={3}
            value={rejectReason}
            onChange={(event) => setRejectReason(event.target.value)}
            className="input h-auto py-2"
          />
        </Field>
      </Modal>
    </>
  )
}
