import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, Truck } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import {
  Badge,
  Card,
  ErrorState,
  Field,
  LoadingBlock,
  Modal,
  PageHeader,
  Spinner,
  useToast,
} from '@/components/ui'
import { useAuth } from '@/lib/auth'
import {
  formatDateTime,
  formatPrice,
  ORDER_STATUS_TONE,
  PAYMENT_STATUS_TONE,
} from '@/lib/utils'

interface OrderDetailData {
  id: string
  orderNumber: string
  email: string
  phone: string
  status: string
  subtotal: number
  discount: number
  shippingFee: number
  taxAmount: number
  total: number
  couponCode: string | null
  shippingAddress: Record<string, string>
  shippingMethod: string
  giftMessage: string | null
  customerNote: string | null
  adminNote: string | null
  trackingNumber: string | null
  carrier: string | null
  estimatedDelivery: string | null
  placedAt: string
  user: { id: string; firstName: string; lastName: string; email: string } | null
  items: Array<{
    id: string
    productId: string | null
    slug: string
    name: string
    imageUrl: string | null
    sku: string | null
    colorName: string | null
    sizeName: string | null
    unitPrice: number
    quantity: number
    lineTotal: number
  }>
  payments: Array<{
    id: string
    status: string
    method: string
    amount: number
    providerPaymentId: string | null
    capturedAt: string | null
    failureReason: string | null
  }>
  refunds: Array<{ id: string; amount: number; status: string; reason: string | null }>
  statusHistory: Array<{
    id: string
    fromStatus: string | null
    toStatus: string
    note: string | null
    createdAt: string
    changedBy: { id: string; name: string } | null
  }>
  invoice: { invoiceNumber: string; issuedAt: string } | null
}

/** Mirrors the backend's transition rules, so the UI cannot offer an illegal move. */
const NEXT_STATUSES: Record<string, string[]> = {
  PENDING: ['PLACED', 'CONFIRMED', 'CANCELLED'],
  PLACED: ['CONFIRMED', 'PROCESSING', 'CANCELLED'],
  CONFIRMED: ['PROCESSING', 'SHIPPED', 'CANCELLED'],
  PROCESSING: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['DELIVERED', 'RETURNED'],
  DELIVERED: ['RETURNED'],
  CANCELLED: [],
  RETURNED: [],
}

export function OrderDetail() {
  const { id } = useParams<{ id: string }>()
  const { can } = useAuth()
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const [statusModal, setStatusModal] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [tracking, setTracking] = useState('')
  const [carrier, setCarrier] = useState('')
  const [refundModal, setRefundModal] = useState(false)
  const [refundAmount, setRefundAmount] = useState('')
  const [refundReason, setRefundReason] = useState('')

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin-order', id],
    queryFn: async () => (await api.get<OrderDetailData>(`/admin/orders/${id}`)).data,
    enabled: Boolean(id),
  })

  const statusMutation = useMutation({
    mutationFn: async (status: string) =>
      api.patch(`/admin/orders/${id}/status`, {
        status,
        note: note || undefined,
        trackingNumber: tracking || undefined,
        carrier: carrier || undefined,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-order', id] })
      void queryClient.invalidateQueries({ queryKey: ['sidebar-counts'] })
      setStatusModal(null)
      setNote('')
      setTracking('')
      setCarrier('')
      toast({ title: 'Order updated', description: 'The customer has been notified.' })
    },
    onError: (caught) =>
      toast({
        title: 'Could not update',
        description: caught instanceof ApiError ? caught.message : 'Unexpected error.',
        tone: 'error',
      }),
  })

  const refundMutation = useMutation({
    mutationFn: async () =>
      api.post('/admin/payments/refunds', {
        orderId: id,
        amount: refundAmount ? Number(refundAmount) : undefined,
        reason: refundReason,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-order', id] })
      setRefundModal(false)
      setRefundAmount('')
      setRefundReason('')
      toast({ title: 'Refund requested', description: 'Approve it from the Refunds screen.' })
    },
    onError: (caught) =>
      toast({
        title: 'Could not request refund',
        description: caught instanceof ApiError ? caught.message : 'Unexpected error.',
        tone: 'error',
      }),
  })

  if (isLoading) return <LoadingBlock rows={10} />
  if (error) return <ErrorState error={error} retry={() => void refetch()} />
  if (!data) return null

  const address = data.shippingAddress
  const captured = data.payments.find((payment) => payment.status === 'CAPTURED')
  const nextStatuses = NEXT_STATUSES[data.status] ?? []

  return (
    <>
      <Link
        to="/orders"
        className="mb-5 inline-flex items-center gap-1.5 text-[0.6875rem] uppercase tracking-[0.12em] text-taupe transition-colors hover:text-charcoal"
      >
        <ChevronLeft className="h-3.5 w-3.5" strokeWidth={1.5} />
        All orders
      </Link>

      <PageHeader
        title={data.orderNumber}
        description={`Placed ${formatDateTime(data.placedAt)} · ${data.shippingMethod} shipping`}
        actions={
          <div className="flex flex-wrap gap-2">
            {can('orders.update') &&
              nextStatuses.map((status) => (
                <button
                  key={status}
                  type="button"
                  onClick={() => setStatusModal(status)}
                  className={status === 'CANCELLED' ? 'btn-outline' : 'btn-primary'}
                >
                  Mark {status.toLowerCase()}
                </button>
              ))}
            {can('refunds.create') && captured && (
              <button type="button" onClick={() => setRefundModal(true)} className="btn-outline">
                Refund
              </button>
            )}
          </div>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <Badge className={ORDER_STATUS_TONE[data.status]}>{data.status}</Badge>
        {data.payments[0] && (
          <Badge className={PAYMENT_STATUS_TONE[data.payments[0].status]}>
            Payment {data.payments[0].status}
          </Badge>
        )}
        {data.invoice && (
          <span className="text-xs text-taupe">Invoice {data.invoice.invoiceNumber}</span>
        )}
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card title="Items">
            <ul className="divide-y divide-line">
              {data.items.map((item) => (
                <li key={item.id} className="flex gap-4 px-5 py-4">
                  <div className="h-20 w-16 shrink-0 overflow-hidden bg-ivory-deep">
                    {item.imageUrl && (
                      <img src={item.imageUrl} alt="" className="h-full w-full object-cover" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <Link
                      to={item.productId ? `/products/${item.productId}` : '#'}
                      className="block truncate text-sm text-charcoal hover:text-gold"
                    >
                      {item.name}
                    </Link>
                    <p className="mt-1 text-xs text-taupe">
                      {[item.colorName, item.sizeName].filter(Boolean).join(' · ')}
                      {item.sku && ` · ${item.sku}`}
                    </p>
                    <p className="mt-1 text-xs text-mocha">
                      {formatPrice(item.unitPrice)} × {item.quantity}
                    </p>
                  </div>
                  <p className="shrink-0 text-sm text-charcoal">{formatPrice(item.lineTotal)}</p>
                </li>
              ))}
            </ul>

            <dl className="space-y-2 border-t border-line px-5 py-4 text-sm">
              <Row label="Subtotal" value={formatPrice(data.subtotal)} />
              {data.discount > 0 && (
                <Row
                  label={`Discount${data.couponCode ? ` (${data.couponCode})` : ''}`}
                  value={`− ${formatPrice(data.discount)}`}
                  tone="burgundy"
                />
              )}
              <Row
                label="Shipping"
                value={data.shippingFee === 0 ? 'Complimentary' : formatPrice(data.shippingFee)}
              />
              <Row label="GST (included)" value={formatPrice(data.taxAmount)} muted />
              <div className="flex justify-between border-t border-line pt-3">
                <dt className="eyebrow text-charcoal">Total</dt>
                <dd className="font-serif text-xl text-charcoal">{formatPrice(data.total)}</dd>
              </div>
            </dl>
          </Card>

          <Card title="History">
            <ol className="divide-y divide-line">
              {data.statusHistory.map((entry) => (
                <li key={entry.id} className="px-5 py-3.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-sm text-charcoal">
                      {entry.fromStatus ? `${entry.fromStatus} → ` : ''}
                      {entry.toStatus}
                    </p>
                    <p className="text-[0.6875rem] text-taupe">
                      {formatDateTime(entry.createdAt)}
                      {entry.changedBy && ` · ${entry.changedBy.name}`}
                    </p>
                  </div>
                  {entry.note && <p className="mt-1 text-xs text-mocha">{entry.note}</p>}
                </li>
              ))}
            </ol>
          </Card>

          {data.payments.length > 0 && (
            <Card title="Payments">
              <ul className="divide-y divide-line">
                {data.payments.map((payment) => (
                  <li key={payment.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                    <Badge className={PAYMENT_STATUS_TONE[payment.status]}>{payment.status}</Badge>
                    <span className="text-sm text-charcoal">{formatPrice(payment.amount)}</span>
                    <span className="text-xs text-taupe">{payment.method}</span>
                    {payment.providerPaymentId && (
                      <code className="bg-cream px-1.5 py-0.5 text-[0.6875rem] text-mocha">
                        {payment.providerPaymentId}
                      </code>
                    )}
                    {payment.failureReason && (
                      <span className="text-xs text-burgundy">{payment.failureReason}</span>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {data.refunds.length > 0 && (
            <Card title="Refunds">
              <ul className="divide-y divide-line">
                {data.refunds.map((refund) => (
                  <li key={refund.id} className="flex items-center gap-3 px-5 py-3.5">
                    <Badge className="border-burgundy/40 text-burgundy">{refund.status}</Badge>
                    <span className="text-sm text-charcoal">{formatPrice(refund.amount)}</span>
                    {refund.reason && <span className="text-xs text-mocha">{refund.reason}</span>}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <Card title="Customer">
            <div className="space-y-3 px-5 py-4 text-sm">
              <p className="text-charcoal">
                {data.user ? (
                  <Link to={`/customers/${data.user.id}`} className="hover:text-gold">
                    {data.user.firstName} {data.user.lastName}
                  </Link>
                ) : (
                  'Guest checkout'
                )}
              </p>
              <p className="text-mocha">{data.email}</p>
              <p className="text-mocha">{data.phone}</p>
            </div>
          </Card>

          <Card title="Delivery">
            <address className="space-y-1 px-5 py-4 text-sm not-italic leading-relaxed text-mocha">
              <span className="block text-charcoal">{address.fullName}</span>
              <span className="block">{address.line1}</span>
              {address.line2 && <span className="block">{address.line2}</span>}
              <span className="block">
                {address.city}, {address.state} {address.postalCode}
              </span>
              <span className="block">{address.country ?? 'India'}</span>
            </address>

            {(data.trackingNumber || data.estimatedDelivery) && (
              <div className="border-t border-line px-5 py-4 text-sm">
                {data.trackingNumber && (
                  <p className="flex items-center gap-2 text-charcoal">
                    <Truck className="h-3.5 w-3.5 text-gold" strokeWidth={1.5} />
                    {data.trackingNumber}
                    {data.carrier && <span className="text-taupe">({data.carrier})</span>}
                  </p>
                )}
                {data.estimatedDelivery && (
                  <p className="mt-1 text-xs text-taupe">
                    Estimated {formatDateTime(data.estimatedDelivery)}
                  </p>
                )}
              </div>
            )}
          </Card>

          {(data.giftMessage || data.customerNote) && (
            <Card title="Notes">
              <div className="space-y-3 px-5 py-4 text-sm">
                {data.giftMessage && (
                  <div>
                    <p className="eyebrow mb-1 text-taupe">Gift message</p>
                    <p className="text-mocha">{data.giftMessage}</p>
                  </div>
                )}
                {data.customerNote && (
                  <div>
                    <p className="eyebrow mb-1 text-taupe">Customer note</p>
                    <p className="text-mocha">{data.customerNote}</p>
                  </div>
                )}
              </div>
            </Card>
          )}
        </div>
      </div>

      {/* Status change */}
      <Modal
        open={Boolean(statusModal)}
        onClose={() => setStatusModal(null)}
        title={`Mark as ${statusModal?.toLowerCase()}`}
        footer={
          <>
            <button type="button" onClick={() => setStatusModal(null)} className="btn-ghost">
              Cancel
            </button>
            <button
              type="button"
              onClick={() => statusModal && statusMutation.mutate(statusModal)}
              disabled={statusMutation.isPending}
              className="btn-primary"
            >
              {statusMutation.isPending && <Spinner />}
              Confirm
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-mocha">
            The customer is emailed automatically when an order is confirmed, shipped, delivered or
            cancelled.
          </p>

          {statusModal === 'SHIPPED' && (
            <>
              <Field label="Tracking number" htmlFor="tracking">
                <input
                  id="tracking"
                  value={tracking}
                  onChange={(event) => setTracking(event.target.value)}
                  className="input"
                  placeholder="BLR8827194IN"
                />
              </Field>
              <Field label="Carrier" htmlFor="carrier">
                <input
                  id="carrier"
                  value={carrier}
                  onChange={(event) => setCarrier(event.target.value)}
                  className="input"
                  placeholder="Blue Dart"
                />
              </Field>
            </>
          )}

          <Field label="Internal note" htmlFor="note" hint="Recorded in the order history.">
            <textarea
              id="note"
              rows={3}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              className="input h-auto py-2"
            />
          </Field>

          {statusModal === 'CANCELLED' && (
            <p className="border border-gold/40 bg-gold/5 px-4 py-3 text-xs text-gold">
              Cancelling returns every item to stock. Any captured payment must be refunded
              separately.
            </p>
          )}
        </div>
      </Modal>

      {/* Refund */}
      <Modal
        open={refundModal}
        onClose={() => setRefundModal(false)}
        title="Request a refund"
        footer={
          <>
            <button type="button" onClick={() => setRefundModal(false)} className="btn-ghost">
              Cancel
            </button>
            <button
              type="button"
              onClick={() => refundMutation.mutate()}
              disabled={refundMutation.isPending || refundReason.trim().length < 3}
              className="btn-danger"
            >
              {refundMutation.isPending && <Spinner />}
              Request refund
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <Field
            label="Amount"
            htmlFor="refund-amount"
            hint={`Leave blank to refund the full ${formatPrice(captured?.amount ?? data.total)}.`}
          >
            <input
              id="refund-amount"
              type="number"
              min="1"
              max={captured?.amount ?? data.total}
              value={refundAmount}
              onChange={(event) => setRefundAmount(event.target.value)}
              className="input"
              placeholder="Full amount"
            />
          </Field>

          <Field label="Reason" htmlFor="refund-reason" required>
            <textarea
              id="refund-reason"
              rows={3}
              value={refundReason}
              onChange={(event) => setRefundReason(event.target.value)}
              className="input h-auto py-2"
              placeholder="Returned by customer — piece not as expected."
            />
          </Field>

          <p className="text-xs text-taupe">
            This creates a refund request. No money moves until it is approved on the Refunds
            screen.
          </p>
        </div>
      </Modal>
    </>
  )
}

function Row({
  label,
  value,
  tone,
  muted,
}: {
  label: string
  value: string
  tone?: 'burgundy'
  muted?: boolean
}) {
  return (
    <div className="flex justify-between">
      <dt className={muted ? 'text-taupe' : 'text-mocha'}>{label}</dt>
      <dd
        className={
          tone === 'burgundy' ? 'text-burgundy' : muted ? 'text-taupe' : 'text-charcoal'
        }
      >
        {value}
      </dd>
    </div>
  )
}
