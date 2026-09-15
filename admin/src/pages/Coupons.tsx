import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Percent, Plus, Trash2 } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
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
  Spinner,
  Toggle,
  useToast,
} from '@/components/ui'
import { useAuth } from '@/lib/auth'
import { formatDate, formatPrice } from '@/lib/utils'

interface Coupon {
  id: string
  code: string
  label: string
  description: string | null
  type: 'PERCENT' | 'FIXED'
  value: number
  minimumSubtotal: number | null
  maxDiscount: number | null
  usageLimit: number | null
  usageCount: number
  perUserLimit: number | null
  startsAt: string | null
  endsAt: string | null
  isActive: boolean
  _count: { usages: number }
}

const EMPTY = {
  code: '',
  label: '',
  description: '',
  type: 'PERCENT' as 'PERCENT' | 'FIXED',
  value: '',
  minimumSubtotal: '',
  maxDiscount: '',
  usageLimit: '',
  perUserLimit: '',
  startsAt: '',
  endsAt: '',
  isActive: true,
}

export function Coupons() {
  const { can } = useAuth()
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const [editing, setEditing] = useState<Coupon | null>(null)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<Coupon | null>(null)
  const [form, setForm] = useState(EMPTY)

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin-coupons'],
    queryFn: async () => (await api.get<Coupon[]>('/admin/coupons')).data,
  })

  function openCreate() {
    setForm(EMPTY)
    setCreating(true)
  }

  function openEdit(coupon: Coupon) {
    setForm({
      code: coupon.code,
      label: coupon.label,
      description: coupon.description ?? '',
      type: coupon.type,
      value: String(coupon.value),
      minimumSubtotal: coupon.minimumSubtotal ? String(coupon.minimumSubtotal) : '',
      maxDiscount: coupon.maxDiscount ? String(coupon.maxDiscount) : '',
      usageLimit: coupon.usageLimit ? String(coupon.usageLimit) : '',
      perUserLimit: coupon.perUserLimit ? String(coupon.perUserLimit) : '',
      startsAt: coupon.startsAt?.slice(0, 10) ?? '',
      endsAt: coupon.endsAt?.slice(0, 10) ?? '',
      isActive: coupon.isActive,
    })
    setEditing(coupon)
  }

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        code: form.code.toUpperCase(),
        label: form.label,
        description: form.description || null,
        type: form.type,
        value: Number(form.value),
        minimumSubtotal: form.minimumSubtotal ? Number(form.minimumSubtotal) : null,
        maxDiscount: form.maxDiscount ? Number(form.maxDiscount) : null,
        usageLimit: form.usageLimit ? Number(form.usageLimit) : null,
        perUserLimit: form.perUserLimit ? Number(form.perUserLimit) : null,
        startsAt: form.startsAt || null,
        endsAt: form.endsAt || null,
        isActive: form.isActive,
      }
      return editing
        ? api.patch(`/admin/coupons/${editing.id}`, body)
        : api.post('/admin/coupons', body)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-coupons'] })
      setCreating(false)
      setEditing(null)
      toast({ title: editing ? 'Discount saved' : 'Discount created' })
    },
    onError: (caught) =>
      toast({
        title: 'Could not save',
        description: caught instanceof ApiError ? caught.message : 'Unexpected error.',
        tone: 'error',
      }),
  })

  const remove = useMutation({
    mutationFn: async (id: string) => api.delete(`/admin/coupons/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-coupons'] })
      setDeleting(null)
      toast({ title: 'Removed' })
    },
  })

  return (
    <>
      <PageHeader
        title="Discounts"
        description="Codes customers can apply at checkout. Validation happens on the server, so a code cannot be forged in the browser."
        actions={
          can('discounts.create') && (
            <button type="button" onClick={openCreate} className="btn-primary">
              <Plus className="h-3.5 w-3.5" strokeWidth={2} />
              New code
            </button>
          )
        }
      />

      <Card>
        {isLoading ? (
          <LoadingBlock rows={5} />
        ) : error ? (
          <ErrorState error={error} retry={() => void refetch()} />
        ) : !data?.length ? (
          <EmptyState
            icon={<Percent className="h-6 w-6" strokeWidth={1} />}
            title="No discount codes"
            description="Create a code and customers can apply it in the bag."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem]">
              <thead>
                <tr>
                  <th className="th">Code</th>
                  <th className="th">Discount</th>
                  <th className="th">Conditions</th>
                  <th className="th text-right">Used</th>
                  <th className="th">Window</th>
                  <th className="th">Status</th>
                  <th className="th w-20 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.map((coupon) => (
                  <tr key={coupon.id} className="transition-colors hover:bg-cream/40">
                    <td className="td">
                      <code className="bg-cream px-2 py-1 text-xs text-charcoal">
                        {coupon.code}
                      </code>
                      <span className="mt-1 block text-[0.6875rem] text-taupe">
                        {coupon.label}
                      </span>
                    </td>

                    <td className="td text-charcoal">
                      {coupon.type === 'PERCENT'
                        ? `${coupon.value}%`
                        : formatPrice(coupon.value)}
                    </td>

                    <td className="td text-xs text-mocha">
                      {coupon.minimumSubtotal
                        ? `Min ${formatPrice(coupon.minimumSubtotal)}`
                        : 'No minimum'}
                      {coupon.perUserLimit && ` · ${coupon.perUserLimit} per customer`}
                    </td>

                    <td className="td text-right tabular-nums text-mocha">
                      {coupon.usageCount}
                      {coupon.usageLimit ? ` / ${coupon.usageLimit}` : ''}
                    </td>

                    <td className="td text-[0.6875rem] text-taupe">
                      {coupon.startsAt || coupon.endsAt
                        ? `${coupon.startsAt ? formatDate(coupon.startsAt) : 'now'} → ${coupon.endsAt ? formatDate(coupon.endsAt) : 'open'}`
                        : 'Always'}
                    </td>

                    <td className="td">
                      <Badge
                        className={
                          coupon.isActive
                            ? 'border-success/40 text-success'
                            : 'border-line-strong text-taupe'
                        }
                      >
                        {coupon.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                    </td>

                    <td className="td">
                      <div className="flex justify-end gap-1">
                        {can('discounts.update') && (
                          <button
                            type="button"
                            onClick={() => openEdit(coupon)}
                            aria-label={`Edit ${coupon.code}`}
                            className="p-1.5 text-taupe transition-colors hover:text-charcoal"
                          >
                            <Pencil className="h-3.5 w-3.5" strokeWidth={1.5} />
                          </button>
                        )}
                        {can('discounts.delete') && (
                          <button
                            type="button"
                            onClick={() => setDeleting(coupon)}
                            aria-label={`Delete ${coupon.code}`}
                            className="p-1.5 text-taupe transition-colors hover:text-burgundy"
                          >
                            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal
        open={creating || Boolean(editing)}
        onClose={() => {
          setCreating(false)
          setEditing(null)
        }}
        title={editing ? `Edit ${editing.code}` : 'New discount code'}
        footer={
          <>
            <button
              type="button"
              onClick={() => {
                setCreating(false)
                setEditing(null)
              }}
              className="btn-ghost"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => save.mutate()}
              disabled={save.isPending || !form.code || !form.label || !form.value}
              className="btn-primary"
            >
              {save.isPending && <Spinner />}
              {editing ? 'Save changes' : 'Create'}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Code" htmlFor="c-code" required hint="Letters, numbers, - and _ only.">
              <input
                id="c-code"
                value={form.code}
                onChange={(event) => setForm({ ...form, code: event.target.value.toUpperCase() })}
                className="input font-mono"
                placeholder="HERITAGE10"
              />
            </Field>

            <Field label="Type" htmlFor="c-type" required>
              <select
                id="c-type"
                value={form.type}
                onChange={(event) =>
                  setForm({ ...form, type: event.target.value as 'PERCENT' | 'FIXED' })
                }
                className="input"
              >
                <option value="PERCENT">Percentage off</option>
                <option value="FIXED">Fixed amount off</option>
              </select>
            </Field>
          </div>

          <Field
            label="Label"
            htmlFor="c-label"
            required
            hint="Shown to the customer when the code is applied."
          >
            <input
              id="c-label"
              value={form.label}
              onChange={(event) => setForm({ ...form, label: event.target.value })}
              className="input"
              placeholder="10% off your order"
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label={form.type === 'PERCENT' ? 'Percentage' : 'Amount (₹)'}
              htmlFor="c-value"
              required
            >
              <input
                id="c-value"
                type="number"
                min="1"
                max={form.type === 'PERCENT' ? 100 : undefined}
                value={form.value}
                onChange={(event) => setForm({ ...form, value: event.target.value })}
                className="input"
              />
            </Field>

            <Field label="Minimum order (₹)" htmlFor="c-min">
              <input
                id="c-min"
                type="number"
                min="0"
                value={form.minimumSubtotal}
                onChange={(event) => setForm({ ...form, minimumSubtotal: event.target.value })}
                className="input"
                placeholder="No minimum"
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Total uses" htmlFor="c-limit" hint="Leave blank for unlimited.">
              <input
                id="c-limit"
                type="number"
                min="1"
                value={form.usageLimit}
                onChange={(event) => setForm({ ...form, usageLimit: event.target.value })}
                className="input"
                placeholder="Unlimited"
              />
            </Field>

            <Field label="Uses per customer" htmlFor="c-peruser">
              <input
                id="c-peruser"
                type="number"
                min="1"
                value={form.perUserLimit}
                onChange={(event) => setForm({ ...form, perUserLimit: event.target.value })}
                className="input"
                placeholder="Unlimited"
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Starts" htmlFor="c-start">
              <input
                id="c-start"
                type="date"
                value={form.startsAt}
                onChange={(event) => setForm({ ...form, startsAt: event.target.value })}
                className="input"
              />
            </Field>

            <Field label="Ends" htmlFor="c-end">
              <input
                id="c-end"
                type="date"
                value={form.endsAt}
                onChange={(event) => setForm({ ...form, endsAt: event.target.value })}
                className="input"
              />
            </Field>
          </div>

          <Toggle
            checked={form.isActive}
            onChange={(next) => setForm({ ...form, isActive: next })}
            label="Active"
            description="Inactive codes are rejected at checkout."
          />
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
        busy={remove.isPending}
        title={`Remove ${deleting?.code}?`}
        message={
          (deleting?._count.usages ?? 0) > 0
            ? `This code has been used on ${deleting?._count.usages} order(s), so it will be deactivated rather than deleted — order history stays intact.`
            : 'This code will be deleted permanently.'
        }
      />
    </>
  )
}
