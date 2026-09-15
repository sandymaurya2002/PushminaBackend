import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, Megaphone, Trash2 } from 'lucide-react'
import { api, ApiError, type ApiMeta } from '@/lib/api'
import {
  Card,
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
import { cn, relativeTime, titleCase } from '@/lib/utils'

interface NotificationRow {
  id: string
  type: string
  title: string
  body: string
  link: string | null
  isRead: boolean
  createdAt: string
}

export function Notifications() {
  const { can } = useAuth()
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const [page, setPage] = useState(1)
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [broadcasting, setBroadcasting] = useState(false)
  const [form, setForm] = useState({
    title: '',
    body: '',
    link: '',
    audience: 'marketing-opted-in',
  })

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin-notifications', page, unreadOnly],
    queryFn: async () => {
      const result = await api.get<NotificationRow[]>('/admin/notifications', {
        page,
        limit: 25,
        unreadOnly,
      })
      return { rows: result.data, meta: result.meta as ApiMeta }
    },
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin-notifications'] })
    void queryClient.invalidateQueries({ queryKey: ['sidebar-counts'] })
  }

  const markRead = useMutation({
    mutationFn: async (id: string) => api.post(`/admin/notifications/${id}/read`),
    onSuccess: invalidate,
  })

  const markAll = useMutation({
    mutationFn: async () => api.post('/admin/notifications/read-all'),
    onSuccess: () => {
      invalidate()
      toast({ title: 'All marked as read' })
    },
  })

  const remove = useMutation({
    mutationFn: async (id: string) => api.delete(`/admin/notifications/${id}`),
    onSuccess: invalidate,
  })

  const broadcast = useMutation({
    mutationFn: async () => api.post<{ sent: number }>('/admin/notifications/broadcast', form),
    onSuccess: (result) => {
      setBroadcasting(false)
      setForm({ title: '', body: '', link: '', audience: 'marketing-opted-in' })
      toast({
        title: 'Notification sent',
        description: `Delivered to ${result.data.sent} customer${result.data.sent === 1 ? '' : 's'}.`,
      })
    },
    onError: (caught) =>
      toast({
        title: 'Could not send',
        description: caught instanceof ApiError ? caught.message : 'Unexpected error.',
        tone: 'error',
      }),
  })

  const unread = (data?.meta?.unreadCount ?? 0) as number

  return (
    <>
      <PageHeader
        title="Notifications"
        description="System alerts for the team, and promotional broadcasts to customers."
        actions={
          <div className="flex gap-2">
            {unread > 0 && (
              <button
                type="button"
                onClick={() => markAll.mutate()}
                className="btn-outline"
              >
                Mark all read
              </button>
            )}
            {can('notifications.send') && (
              <button
                type="button"
                onClick={() => setBroadcasting(true)}
                className="btn-primary"
              >
                <Megaphone className="h-3.5 w-3.5" strokeWidth={1.5} />
                Broadcast
              </button>
            )}
          </div>
        }
      />

      <div className="mb-4 flex gap-1">
        <button
          type="button"
          onClick={() => {
            setUnreadOnly(false)
            setPage(1)
          }}
          className={`chip transition-colors ${
            !unreadOnly
              ? 'border-charcoal bg-charcoal text-ivory'
              : 'border-line-strong text-mocha hover:border-charcoal'
          }`}
        >
          All
        </button>
        <button
          type="button"
          onClick={() => {
            setUnreadOnly(true)
            setPage(1)
          }}
          className={`chip transition-colors ${
            unreadOnly
              ? 'border-charcoal bg-charcoal text-ivory'
              : 'border-line-strong text-mocha hover:border-charcoal'
          }`}
        >
          Unread{unread > 0 && ` (${unread})`}
        </button>
      </div>

      <Card>
        {isLoading ? (
          <LoadingBlock rows={6} />
        ) : error ? (
          <ErrorState error={error} retry={() => void refetch()} />
        ) : !data?.rows.length ? (
          <EmptyState
            icon={<Bell className="h-6 w-6" strokeWidth={1} />}
            title="Nothing here"
            description="New orders, payments, low stock and enquiries will appear here."
          />
        ) : (
          <>
            <ul className="divide-y divide-line">
              {data.rows.map((notification) => (
                <li
                  key={notification.id}
                  className={cn(
                    'flex items-start gap-4 px-5 py-4 transition-colors',
                    !notification.isRead && 'bg-gold/[0.04]',
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
                      notification.isRead ? 'bg-line-strong' : 'bg-gold',
                    )}
                  />

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm text-charcoal">{notification.title}</p>
                      <span className="chip border-line-strong text-taupe">
                        {titleCase(notification.type.replace(/^ADMIN_/, ''))}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-mocha">{notification.body}</p>
                    <p className="mt-1.5 text-[0.6875rem] text-taupe">
                      {relativeTime(notification.createdAt)}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    {notification.link && (
                      <Link
                        to={notification.link}
                        onClick={() => !notification.isRead && markRead.mutate(notification.id)}
                        className="btn-outline btn-sm"
                      >
                        View
                      </Link>
                    )}
                    {!notification.isRead && (
                      <button
                        type="button"
                        onClick={() => markRead.mutate(notification.id)}
                        className="text-[0.6875rem] uppercase tracking-[0.1em] text-taupe hover:text-charcoal"
                      >
                        Mark read
                      </button>
                    )}
                    {can('notifications.delete') && (
                      <button
                        type="button"
                        onClick={() => remove.mutate(notification.id)}
                        aria-label="Delete"
                        className="p-1.5 text-taupe transition-colors hover:text-burgundy"
                      >
                        <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>

            <Pagination
              page={data.meta?.page ?? 1}
              totalPages={data.meta?.totalPages ?? 1}
              total={data.meta?.total ?? 0}
              onChange={setPage}
            />
          </>
        )}
      </Card>

      <Modal
        open={broadcasting}
        onClose={() => setBroadcasting(false)}
        title="Broadcast to customers"
        footer={
          <>
            <button type="button" onClick={() => setBroadcasting(false)} className="btn-ghost">
              Cancel
            </button>
            <button
              type="button"
              onClick={() => broadcast.mutate()}
              disabled={broadcast.isPending || !form.title.trim() || !form.body.trim()}
              className="btn-primary"
            >
              {broadcast.isPending && <Spinner />}
              Send
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Title" htmlFor="b-title" required>
            <input
              id="b-title"
              value={form.title}
              onChange={(event) => setForm({ ...form, title: event.target.value })}
              className="input"
              placeholder="New arrivals are here"
            />
          </Field>

          <Field label="Message" htmlFor="b-body" required>
            <textarea
              id="b-body"
              rows={3}
              value={form.body}
              onChange={(event) => setForm({ ...form, body: event.target.value })}
              className="input h-auto py-2"
            />
          </Field>

          <Field label="Link" htmlFor="b-link" hint="Optional. Where the notification takes them.">
            <input
              id="b-link"
              value={form.link}
              onChange={(event) => setForm({ ...form, link: event.target.value })}
              className="input"
              placeholder="/collections/new-arrivals"
            />
          </Field>

          <Field label="Audience" htmlFor="b-audience">
            <select
              id="b-audience"
              value={form.audience}
              onChange={(event) => setForm({ ...form, audience: event.target.value })}
              className="input"
            >
              <option value="marketing-opted-in">Customers who opted into marketing</option>
              <option value="all">All active customers</option>
            </select>
          </Field>

          <p className="border border-gold/40 bg-gold/5 px-4 py-3 text-xs leading-relaxed text-gold">
            Sending to customers who have not opted into marketing is legally risky in most
            jurisdictions. Use “all” only for genuine service announcements.
          </p>
        </div>
      </Modal>
    </>
  )
}
