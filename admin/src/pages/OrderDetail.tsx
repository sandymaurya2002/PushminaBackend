import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, ExternalLink, RefreshCw, Truck, Undo2 } from 'lucide-react'
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
  CURRENCY_SYMBOL,
  type Currency,
  formatDate,
  formatDateTime,
  formatPrice,
  ORDER_STATUS_TONE,
  PAYMENT_STATUS_TONE,
  titleCase,
} from '@/lib/utils'

interface PaymentEntry {
  id: string
  provider: string
  status: string
  method: string | null
  amount: number
  amountRefunded: number
  providerOrderId: string | null
  providerPaymentId: string | null
  failureReason: string | null
  errorCode: string | null
  createdAt: string
  authorizedAt: string | null
  capturedAt: string | null
  failedAt: string | null
}

interface RefundEntry {
  id: string
  amount: number
  status: string
  reason: string | null
  providerRefundId: string | null
  failureReason: string | null
  createdAt: string
  completedAt: string | null
  requestedBy: { id: string; name: string } | null
  processedBy: { id: string; name: string } | null
}

interface OrderDetailData {
  id: string
  orderNumber: string
  email: string
  phone: string
  status: string
  allowedTransitions: string[]
  paymentStatus: string
  paymentMethod: string
  currency: Currency
  pricingCountry: string | null
  subtotal: number
  discount: number
  shippingFee: number
  taxAmount: number
  total: number
  refunded: number
  refundable: number
  couponCode: string | null
  shippingAddress: Record<string, string>
  shippingMethod: string
  giftMessage: string | null
  customerNote: string | null
  adminNote: string | null
  trackingNumber: string | null
  trackingUrl: string | null
  carrier: string | null
  estimatedDelivery: string | null
  returnReason: string | null
  returnRequestedAt: string | null
  paymentExpiresAt: string | null
  placedAt: string
  paidAt: string | null
  shippedAt: string | null
  deliveredAt: string | null
  cancelledAt: string | null
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
  payments: PaymentEntry[]
  refunds: RefundEntry[]
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

/** The permission the API requires for each target status. */
function permissionFor(status: string): string {
  if (status === 'CANCELLED') return 'orders.cancel'
  if (['PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'RETURNED'].includes(status)) {
    return 'orders.fulfil'
  }
  return 'orders.update'
}

function actionLabel(from: string, to: string): string {
  if (from === 'RETURN_REQUESTED' && to === 'RETURNED') return 'Approve return'
  if (from === 'RETURN_REQUESTED' && to === 'DELIVERED') return 'Reject return'
  if (to === 'RETURNED') return 'Mark returned'
  if (to === 'RETURN_REQUESTED') return 'Log return request'
  if (to === 'PROCESSING') return 'Start processing'
  if (to === 'CANCELLED') return 'Cancel order'
  return `Mark ${titleCase(to).toLowerCase()}`
}

const REFUND_TONE: Record<string, string> = {
  REQUESTED: 'border-gold/50 text-gold',
  PROCESSING: 'border-gold/50 text-gold',
  COMPLETED: 'border-success/40 text-success',
  FAILED: 'border-burgundy/40 text-burgundy',
  REJECTED: 'border-line-strong text-taupe',
}

function errorText(caught: unknown): string {
  return caught instanceof ApiError ? caught.message : 'Unexpected error.'
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
  const [trackingUrl, setTrackingUrl] = useState('')
  const [estimated, setEstimated] = useState('')

  const [refundOpen, setRefundOpen] = useState(false)
  const [refundAmount, setRefundAmount] = useState('')
  const [refundReason, setRefundReason] = useState('')

  const [shippingOpen, setShippingOpen] = useState(false)
  const [adminNote, setAdminNote] = useState('')

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin-order', id],
    queryFn: async () => (await api.get<OrderDetailData>(`/admin/orders/${id}`)).data,
    enabled: Boolean(id),
  })

  function refreshAll() {
    void queryClient.invalidateQueries({ queryKey: ['admin-order', id] })
    void queryClient.invalidateQueries({ queryKey: ['admin-orders'] })
    void queryClient.invalidateQueries({ queryKey: ['sidebar-counts'] })
  }

  function openStatus(status: string) {
    setNote('')
    setTracking(data?.trackingNumber ?? '')
    setCarrier(data?.carrier ?? '')
    setTrackingUrl(data?.trackingUrl ?? '')
    setEstimated(data?.estimatedDelivery ?? '')
    setStatusModal(status)
  }

  const statusMutation = useMutation({
    mutationFn: async (status: string) =>
      api.patch(`/admin/orders/${id}/status`, {
        status,
        note: note || undefined,
        trackingNumber: tracking || undefined,
        carrier: carrier || undefined,
        trackingUrl: trackingUrl || undefined,
        estimatedDelivery: estimated || undefined,
      }),
    onSuccess: () => {
      refreshAll()
      setStatusModal(null)
      toast({ title: 'Order updated', description: 'The customer sees the new status in their account.' })
    },
    onError: (caught) => toast({ title: 'Could not update', description: errorText(caught), tone: 'error' }),
  })

  const shippingMutation = useMutation({
    mutationFn: async () =>
      api.patch(`/admin/orders/${id}`, {
        adminNote: adminNote.trim() || null,
        trackingNumber: tracking.trim() || null,
        carrier: carrier.trim() || null,
        trackingUrl: trackingUrl.trim() || null,
        estimatedDelivery: estimated || null,
      }),
    onSuccess: () => {
      refreshAll()
      setShippingOpen(false)
      toast({ title: 'Delivery details saved' })
    },
    onError: (caught) => toast({ title: 'Could not save', description: errorText(caught), tone: 'error' }),
  })

  const refundMutation = useMutation({
    mutationFn: async () =>
      api.post(`/admin/orders/${id}/refund`, {
        amount: refundAmount ? Number(refundAmount) : undefined,
        reason: refundReason.trim(),
      }),
    onSuccess: () => {
      refreshAll()
      void queryClient.invalidateQueries({ queryKey: ['admin-refunds'] })
      setRefundOpen(false)
      toast({
        title: 'Refund requested',
        description: can('refunds.approve')
          ? 'Approve it on the Refunds page to send it to the payment gateway.'
          : 'An administrator with refund approval will process it.',
      })
    },
    onError: (caught) => toast({ title: 'Could not request refund', description: errorText(caught), tone: 'error' }),
  })

  const syncMutation = useMutation({
    mutationFn: async () => api.post(`/admin/orders/${id}/payments/sync`),
    onSuccess: () => {
      refreshAll()
      toast({ title: 'Payment re-checked', description: 'Status refreshed from Razorpay.' })
    },
    onError: (caught) => toast({ title: 'Could not re-check', description: errorText(caught), tone: 'error' }),
  })

  if (isLoading) return <LoadingBlock rows={10} />
  if (error) return <ErrorState error={error} retry={() => void refetch()} />
  if (!data) return null

  const address = data.shippingAddress
  const nextStatuses = data.allowedTransitions.filter((status) => can(permissionFor(status)))
  const online = data.paymentMethod === 'RAZORPAY'
  const needsTracking = statusModal === 'SHIPPED' || statusModal === 'OUT_FOR_DELIVERY'

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
        description={`Placed ${formatDateTime(data.placedAt)} · ${titleCase(data.shippingMethod)} shipping`}
        actions={
          <div className="flex flex-wrap gap-2">
            {nextStatuses.map((status) => (
              <button
                key={status}
                type="button"
                onClick={() => openStatus(status)}
                className={
                  status === 'CANCELLED' || (data.status === 'RETURN_REQUESTED' && status === 'DELIVERED')
                    ? 'btn-outline'
                    : 'btn-primary'
                }
              >
                {actionLabel(data.status, status)}
              </button>
            ))}
            {online && can('payments.sync') && (
              <button
                type="button"
                onClick={() => syncMutation.mutate()}
                disabled={syncMutation.isPending}
                className="btn-outline"
              >
                {syncMutation.isPending ? <Spinner /> : <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.5} />}
                Re-check payment
              </button>
            )}
            {data.refundable > 0 && can('refunds.create') && (
              <button
                type="button"
                onClick={() => {
                  setRefundAmount('')
                  setRefundReason('')
                  setRefundOpen(true)
                }}
                className="btn-outline"
              >
                <Undo2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                Refund
              </button>
            )}
          </div>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <Badge className={ORDER_STATUS_TONE[data.status]}>{titleCase(data.status)}</Badge>
        <Badge className={PAYMENT_STATUS_TONE[data.paymentStatus]}>
          {data.paymentMethod === 'COD' ? 'Cash on delivery' : 'Online'} · {titleCase(data.paymentStatus).toLowerCase()}
        </Badge>
        <Badge>
          {data.currency === 'USD' ? 'International · USD' : 'India · INR'}
          {data.pricingCountry ? ` · shopper in ${data.pricingCountry}` : ''}
        </Badge>
        {data.refunded > 0 && (
          <span className="text-xs text-burgundy">{formatPrice(data.refunded, data.currency)} refunded</span>
        )}
        {data.paymentExpiresAt && ['PAYMENT_PENDING', 'PAYMENT_FAILED'].includes(data.status) && (
          <span className="text-xs text-taupe">
            Unpaid orders are released at {formatDateTime(data.paymentExpiresAt)}
          </span>
        )}
        {data.invoice && (
          <span className="text-xs text-taupe">Invoice {data.invoice.invoiceNumber}</span>
        )}
      </div>

      {data.status === 'RETURN_REQUESTED' && (
        <div className="mb-6 border border-burgundy/30 bg-burgundy/5 px-5 py-4 text-sm">
          <p className="eyebrow mb-1 text-burgundy">Return requested</p>
          <p className="text-mocha">
            {data.returnReason ?? 'No reason given.'}
            {data.returnRequestedAt && (
              <span className="text-taupe"> · {formatDateTime(data.returnRequestedAt)}</span>
            )}
          </p>
          <p className="mt-2 text-xs text-taupe">
            Approving marks the order returned and puts the items back in stock. Refund the
            customer afterwards from this page. Rejecting returns the order to delivered.
          </p>
        </div>
      )}

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
                      {formatPrice(item.unitPrice, data.currency)} × {item.quantity}
                    </p>
                  </div>
                  <p className="shrink-0 text-sm text-charcoal">{formatPrice(item.lineTotal, data.currency)}</p>
                </li>
              ))}
            </ul>

            <dl className="space-y-2 border-t border-line px-5 py-4 text-sm">
              <Row label="Subtotal" value={formatPrice(data.subtotal, data.currency)} />
              {data.discount > 0 && (
                <Row
                  label={`Discount${data.couponCode ? ` (${data.couponCode})` : ''}`}
                  value={`− ${formatPrice(data.discount, data.currency)}`}
                  tone="burgundy"
                />
              )}
              <Row
                label="Shipping"
                value={data.shippingFee === 0 ? 'Complimentary' : formatPrice(data.shippingFee, data.currency)}
              />
              <Row label="GST (included)" value={formatPrice(data.taxAmount, data.currency)} muted />
              <div className="flex justify-between border-t border-line pt-3">
                <dt className="eyebrow text-charcoal">Total</dt>
                <dd className="font-serif text-xl text-charcoal">{formatPrice(data.total, data.currency)}</dd>
              </div>
              {data.refunded > 0 && (
                <Row label="Refunded" value={`− ${formatPrice(data.refunded, data.currency)}`} tone="burgundy" />
              )}
            </dl>
          </Card>

          <Card title="Payments">
            {data.payments.length === 0 ? (
              <p className="px-5 py-4 text-sm text-taupe">
                {data.paymentMethod === 'COD'
                  ? 'Cash on delivery — collected by the courier.'
                  : 'No payment attempt recorded yet.'}
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {data.payments.map((payment) => (
                  <li key={payment.id} className="space-y-1.5 px-5 py-3.5">
                    <div className="flex flex-wrap items-center gap-3">
                      <Badge className={PAYMENT_STATUS_TONE[payment.status]}>
                        {titleCase(payment.status)}
                      </Badge>
                      <span className="text-sm text-charcoal">{formatPrice(payment.amount, data.currency)}</span>
                      <span className="text-xs uppercase text-taupe">
                        {payment.method ?? payment.provider}
                      </span>
                      {payment.amountRefunded > 0 && (
                        <span className="text-xs text-burgundy">
                          {formatPrice(payment.amountRefunded, data.currency)} refunded
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[0.6875rem] text-taupe">
                      {payment.providerPaymentId && (
                        <span>
                          Payment <code className="text-mocha">{payment.providerPaymentId}</code>
                        </span>
                      )}
                      {payment.providerOrderId && (
                        <span>
                          Gateway order <code className="text-mocha">{payment.providerOrderId}</code>
                        </span>
                      )}
                      <span>Started {formatDateTime(payment.createdAt)}</span>
                      {payment.capturedAt && <span>Captured {formatDateTime(payment.capturedAt)}</span>}
                      {payment.failedAt && <span>Failed {formatDateTime(payment.failedAt)}</span>}
                    </div>
                    {payment.failureReason && (
                      <p className="text-xs text-burgundy">
                        {payment.failureReason}
                        {payment.errorCode && ` (${payment.errorCode})`}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {data.refunds.length > 0 && (
            <Card
              title="Refunds"
              actions={
                can('refunds.view') && (
                  <Link to="/refunds" className="text-[0.6875rem] uppercase tracking-[0.1em] text-taupe hover:text-charcoal">
                    Refund queue
                  </Link>
                )
              }
            >
              <ul className="divide-y divide-line">
                {data.refunds.map((refund) => (
                  <li key={refund.id} className="space-y-1 px-5 py-3.5">
                    <div className="flex flex-wrap items-center gap-3">
                      <Badge className={REFUND_TONE[refund.status] ?? 'border-line-strong text-mocha'}>
                        {titleCase(refund.status)}
                      </Badge>
                      <span className="text-sm text-charcoal">{formatPrice(refund.amount, data.currency)}</span>
                      {refund.reason && <span className="text-xs text-mocha">{refund.reason}</span>}
                    </div>
                    <p className="text-[0.6875rem] text-taupe">
                      Requested {formatDateTime(refund.createdAt)}
                      {refund.requestedBy && ` by ${refund.requestedBy.name}`}
                      {refund.completedAt && ` · completed ${formatDateTime(refund.completedAt)}`}
                      {refund.providerRefundId && ` · ${refund.providerRefundId}`}
                    </p>
                    {refund.failureReason && (
                      <p className="text-xs text-burgundy">{refund.failureReason}</p>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card title="History">
            <ol className="divide-y divide-line">
              {data.statusHistory.map((entry) => (
                <li key={entry.id} className="px-5 py-3.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-sm text-charcoal">
                      {entry.fromStatus ? `${titleCase(entry.fromStatus)} → ` : ''}
                      {titleCase(entry.toStatus)}
                    </p>
                    <p className="text-[0.6875rem] text-taupe">
                      {formatDateTime(entry.createdAt)}
                      {entry.changedBy ? ` · ${entry.changedBy.name}` : ' · System'}
                    </p>
                  </div>
                  {entry.note && <p className="mt-1 text-xs text-mocha">{entry.note}</p>}
                </li>
              ))}
            </ol>
          </Card>
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

          <Card
            title="Delivery"
            actions={
              can('orders.update') && (
                <button
                  type="button"
                  onClick={() => {
                    setTracking(data.trackingNumber ?? '')
                    setCarrier(data.carrier ?? '')
                    setTrackingUrl(data.trackingUrl ?? '')
                    setEstimated(data.estimatedDelivery ?? '')
                    setAdminNote(data.adminNote ?? '')
                    setShippingOpen(true)
                  }}
                  className="text-[0.6875rem] uppercase tracking-[0.1em] text-taupe hover:text-charcoal"
                >
                  Edit
                </button>
              )
            }
          >
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
                  <p className="flex flex-wrap items-center gap-2 text-charcoal">
                    <Truck className="h-3.5 w-3.5 text-gold" strokeWidth={1.5} />
                    {data.trackingNumber}
                    {data.carrier && <span className="text-taupe">({data.carrier})</span>}
                    {data.trackingUrl && (
                      <a
                        href={data.trackingUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-gold hover:underline"
                      >
                        Track <ExternalLink className="h-3 w-3" strokeWidth={1.5} />
                      </a>
                    )}
                  </p>
                )}
                {data.estimatedDelivery && (
                  <p className="mt-1 text-xs text-taupe">
                    Estimated delivery {formatDate(data.estimatedDelivery)}
                  </p>
                )}
              </div>
            )}

            <dl className="space-y-1.5 border-t border-line px-5 py-4 text-xs">
              {[
                ['Paid', data.paidAt],
                ['Shipped', data.shippedAt],
                ['Delivered', data.deliveredAt],
                ['Cancelled', data.cancelledAt],
              ]
                .filter(([, value]) => value)
                .map(([label, value]) => (
                  <div key={label} className="flex justify-between">
                    <dt className="text-taupe">{label}</dt>
                    <dd className="text-mocha">{formatDateTime(value)}</dd>
                  </div>
                ))}
            </dl>
          </Card>

          {(data.giftMessage || data.customerNote || data.adminNote) && (
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
                {data.adminNote && (
                  <div>
                    <p className="eyebrow mb-1 text-taupe">Internal note</p>
                    <p className="whitespace-pre-line text-mocha">{data.adminNote}</p>
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
        title={statusModal ? actionLabel(data.status, statusModal) : ''}
        footer={
          <>
            <button type="button" onClick={() => setStatusModal(null)} className="btn-ghost">
              Back
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
            The customer sees the new status in their account and is emailed about shipping,
            delivery, cancellation and refunds.
          </p>

          {needsTracking && (
            <TrackingFields
              tracking={tracking}
              setTracking={setTracking}
              carrier={carrier}
              setCarrier={setCarrier}
              trackingUrl={trackingUrl}
              setTrackingUrl={setTrackingUrl}
              estimated={estimated}
              setEstimated={setEstimated}
            />
          )}

          <Field label="Note" htmlFor="note" hint="Recorded in the order history.">
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
              Cancelling returns every item to stock
              {data.paymentStatus === 'PAID' ? ' and raises a full refund request for approval.' : '.'}
            </p>
          )}
          {statusModal === 'RETURNED' && (
            <p className="border border-gold/40 bg-gold/5 px-4 py-3 text-xs text-gold">
              The returned items go back into stock. Refund the customer afterwards with the Refund
              button.
            </p>
          )}
        </div>
      </Modal>

      {/* Delivery details */}
      <Modal
        open={shippingOpen}
        onClose={() => setShippingOpen(false)}
        title="Delivery details"
        footer={
          <>
            <button type="button" onClick={() => setShippingOpen(false)} className="btn-ghost">
              Cancel
            </button>
            <button
              type="button"
              onClick={() => shippingMutation.mutate()}
              disabled={shippingMutation.isPending}
              className="btn-primary"
            >
              {shippingMutation.isPending && <Spinner />}
              Save
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <TrackingFields
            tracking={tracking}
            setTracking={setTracking}
            carrier={carrier}
            setCarrier={setCarrier}
            trackingUrl={trackingUrl}
            setTrackingUrl={setTrackingUrl}
            estimated={estimated}
            setEstimated={setEstimated}
          />
          <Field label="Internal note" htmlFor="admin-note" hint="Only visible to staff.">
            <textarea
              id="admin-note"
              rows={3}
              value={adminNote}
              onChange={(event) => setAdminNote(event.target.value)}
              className="input h-auto py-2"
            />
          </Field>
        </div>
      </Modal>

      {/* Refund request */}
      <Modal
        open={refundOpen}
        onClose={() => setRefundOpen(false)}
        title="Request a refund"
        footer={
          <>
            <button type="button" onClick={() => setRefundOpen(false)} className="btn-ghost">
              Cancel
            </button>
            <button
              type="button"
              onClick={() => refundMutation.mutate()}
              disabled={refundMutation.isPending || refundReason.trim().length < 3}
              className="btn-primary"
            >
              {refundMutation.isPending && <Spinner />}
              Request refund
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-mocha">
            Up to {formatPrice(data.refundable, data.currency)} can be refunded.{' '}
            {online
              ? 'Once approved, the money goes back to the original payment method through Razorpay.'
              : 'This is a cash-on-delivery order — once approved, pay the customer manually and the refund is recorded as complete.'}
          </p>
          <Field label={`Amount (${CURRENCY_SYMBOL[data.currency]})`} htmlFor="refund-amount" hint="Leave empty to refund the full remaining amount.">
            <input
              id="refund-amount"
              type="number"
              min={1}
              max={data.refundable}
              step="0.01"
              value={refundAmount}
              onChange={(event) => setRefundAmount(event.target.value)}
              className="input"
              placeholder={String(data.refundable)}
            />
          </Field>
          <Field label="Reason" htmlFor="refund-reason" required>
            <textarea
              id="refund-reason"
              rows={3}
              value={refundReason}
              onChange={(event) => setRefundReason(event.target.value)}
              className="input h-auto py-2"
              placeholder="Returned unworn, item damaged in transit…"
            />
          </Field>
        </div>
      </Modal>
    </>
  )
}

function TrackingFields(props: {
  tracking: string
  setTracking: (value: string) => void
  carrier: string
  setCarrier: (value: string) => void
  trackingUrl: string
  setTrackingUrl: (value: string) => void
  estimated: string
  setEstimated: (value: string) => void
}) {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Tracking number" htmlFor="tracking">
          <input
            id="tracking"
            value={props.tracking}
            onChange={(event) => props.setTracking(event.target.value)}
            className="input"
            placeholder="BLR8827194IN"
          />
        </Field>
        <Field label="Carrier" htmlFor="carrier">
          <input
            id="carrier"
            value={props.carrier}
            onChange={(event) => props.setCarrier(event.target.value)}
            className="input"
            placeholder="Blue Dart"
          />
        </Field>
      </div>
      <Field label="Tracking link" htmlFor="tracking-url" hint="Shown to the customer on their order page.">
        <input
          id="tracking-url"
          type="url"
          value={props.trackingUrl}
          onChange={(event) => props.setTrackingUrl(event.target.value)}
          className="input"
          placeholder="https://www.bluedart.com/tracking?..."
        />
      </Field>
      <Field label="Estimated delivery" htmlFor="estimated">
        <input
          id="estimated"
          type="date"
          value={props.estimated}
          onChange={(event) => props.setEstimated(event.target.value)}
          className="input w-auto"
        />
      </Field>
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
