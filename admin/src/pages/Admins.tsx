import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, ShieldCheck, Trash2 } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import {
  Badge,
  Card,
  ConfirmDialog,
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
import { cn, formatDateTime, titleCase } from '@/lib/utils'

interface AdminRow {
  id: string
  email: string
  name: string
  phone: string | null
  isActive: boolean
  lastLoginAt: string | null
  createdAt: string
  role: { id: string; name: string; slug: string }
}

interface Role {
  id: string
  name: string
  slug: string
  description: string | null
  isSystem: boolean
  adminCount: number
  permissions: string[]
}

interface Permission {
  id: string
  key: string
  label: string
  group: string
}

export function Admins() {
  const [tab, setTab] = useState<'people' | 'roles'>('people')
  const { admin: me, can } = useAuth()
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<AdminRow | null>(null)
  const [editingRole, setEditingRole] = useState<Role | null>(null)
  const [form, setForm] = useState({ name: '', email: '', password: '', roleId: '' })

  const admins = useQuery({
    queryKey: ['admin-users'],
    queryFn: async () => (await api.get<AdminRow[]>('/admin/admins')).data,
    enabled: tab === 'people',
  })

  const roles = useQuery({
    queryKey: ['admin-roles'],
    queryFn: async () =>
      (await api.get<{ roles: Role[]; allPermissions: Permission[] }>('/admin/roles')).data,
  })

  const create = useMutation({
    mutationFn: async () => api.post('/admin/admins', form),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-users'] })
      setCreating(false)
      setForm({ name: '', email: '', password: '', roleId: '' })
      toast({ title: 'Admin created' })
    },
    onError: (caught) =>
      toast({
        title: 'Could not create',
        description: caught instanceof ApiError ? caught.message : 'Unexpected error.',
        tone: 'error',
      }),
  })

  const update = useMutation({
    mutationFn: async ({ id, ...body }: { id: string; isActive?: boolean; roleId?: string }) =>
      api.patch(`/admin/admins/${id}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-users'] })
      toast({ title: 'Admin updated' })
    },
    onError: (caught) =>
      toast({
        title: 'Could not update',
        description: caught instanceof ApiError ? caught.message : 'Unexpected error.',
        tone: 'error',
      }),
  })

  const remove = useMutation({
    mutationFn: async (id: string) => api.delete(`/admin/admins/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-users'] })
      setDeleting(null)
      toast({ title: 'Admin removed' })
    },
    onError: (caught) => {
      setDeleting(null)
      toast({
        title: 'Could not remove',
        description: caught instanceof ApiError ? caught.message : 'Unexpected error.',
        tone: 'error',
      })
    },
  })

  const savePermissions = useMutation({
    mutationFn: async (role: Role) =>
      api.put(`/admin/roles/${role.id}/permissions`, { permissions: role.permissions }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-roles'] })
      setEditingRole(null)
      toast({ title: 'Permissions saved' })
    },
    onError: (caught) =>
      toast({
        title: 'Could not save',
        description: caught instanceof ApiError ? caught.message : 'Unexpected error.',
        tone: 'error',
      }),
  })

  const permissionGroups = (roles.data?.allPermissions ?? []).reduce<
    Record<string, Permission[]>
  >((acc, permission) => {
    if (!acc[permission.group]) acc[permission.group] = []
    acc[permission.group].push(permission)
    return acc
  }, {})

  return (
    <>
      <PageHeader
        title="Admins & roles"
        description="Who can sign in to this panel, and what each role is allowed to do."
        actions={
          tab === 'people' &&
          can('admins.create') && (
            <button
              type="button"
              onClick={() => {
                setForm({
                  name: '',
                  email: '',
                  password: '',
                  roleId: roles.data?.roles[0]?.id ?? '',
                })
                setCreating(true)
              }}
              className="btn-primary"
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={2} />
              New admin
            </button>
          )
        }
      />

      <div className="mb-6 flex gap-1 border-b border-line">
        {(['people', 'roles'] as const).map((entry) => (
          <button
            key={entry}
            type="button"
            onClick={() => setTab(entry)}
            className={cn(
              'relative px-4 py-2.5 text-[0.75rem] uppercase tracking-[0.12em] transition-colors',
              tab === entry ? 'text-charcoal' : 'text-taupe hover:text-charcoal',
            )}
          >
            {entry === 'people' ? 'Admins' : 'Roles & permissions'}
            {tab === entry && (
              <span className="absolute inset-x-0 -bottom-px h-0.5 bg-gold" aria-hidden />
            )}
          </button>
        ))}
      </div>

      {tab === 'people' ? (
        <Card>
          {admins.isLoading ? (
            <LoadingBlock rows={4} />
          ) : admins.error ? (
            <ErrorState error={admins.error} retry={() => void admins.refetch()} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[42rem]">
                <thead>
                  <tr>
                    <th className="th">Name</th>
                    <th className="th">Role</th>
                    <th className="th">Last signed in</th>
                    <th className="th">Status</th>
                    <th className="th w-16 text-right" />
                  </tr>
                </thead>
                <tbody>
                  {admins.data?.map((row) => {
                    const isMe = row.id === me?.id
                    return (
                      <tr key={row.id} className="transition-colors hover:bg-cream/40">
                        <td className="td">
                          <span className="block text-charcoal">
                            {row.name}
                            {isMe && <span className="ml-2 text-xs text-taupe">(you)</span>}
                          </span>
                          <span className="block text-[0.6875rem] text-taupe">{row.email}</span>
                        </td>

                        <td className="td">
                          {can('admins.update') && !isMe ? (
                            <select
                              value={row.role.id}
                              onChange={(event) =>
                                update.mutate({ id: row.id, roleId: event.target.value })
                              }
                              className="input h-8 w-auto py-0 text-xs"
                              aria-label={`Role for ${row.name}`}
                            >
                              {roles.data?.roles.map((role) => (
                                <option key={role.id} value={role.id}>
                                  {role.name}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <span className="text-mocha">{row.role.name}</span>
                          )}
                        </td>

                        <td className="td text-xs text-mocha">
                          {formatDateTime(row.lastLoginAt)}
                        </td>

                        <td className="td">
                          {can('admins.update') && !isMe ? (
                            <Toggle
                              checked={row.isActive}
                              onChange={(next) => update.mutate({ id: row.id, isActive: next })}
                              label={row.isActive ? 'Active' : 'Disabled'}
                            />
                          ) : (
                            <Badge
                              className={
                                row.isActive
                                  ? 'border-success/40 text-success'
                                  : 'border-line-strong text-taupe'
                              }
                            >
                              {row.isActive ? 'Active' : 'Disabled'}
                            </Badge>
                          )}
                        </td>

                        <td className="td text-right">
                          {can('admins.delete') && !isMe && (
                            <button
                              type="button"
                              onClick={() => setDeleting(row)}
                              aria-label={`Remove ${row.name}`}
                              className="p-1.5 text-taupe transition-colors hover:text-burgundy"
                            >
                              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : (
        <div className="space-y-4">
          {roles.data?.roles.map((role) => (
            <Card key={role.id}>
              <div className="flex flex-wrap items-start justify-between gap-4 p-5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-gold" strokeWidth={1.5} />
                    <h3 className="font-serif text-lg text-charcoal">{role.name}</h3>
                    {role.isSystem && (
                      <Badge className="border-line-strong text-taupe">System</Badge>
                    )}
                  </div>
                  <p className="mt-1.5 text-sm text-mocha">{role.description}</p>
                  <p className="mt-2 text-xs text-taupe">
                    {role.slug === 'super-admin'
                      ? 'Every permission, always.'
                      : `${role.permissions.length} permissions`}{' '}
                    · {role.adminCount} admin{role.adminCount === 1 ? '' : 's'}
                  </p>
                </div>

                {role.slug !== 'super-admin' && me?.role.slug === 'super-admin' && (
                  <button
                    type="button"
                    onClick={() => setEditingRole({ ...role })}
                    className="btn-outline btn-sm"
                  >
                    Edit permissions
                  </button>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* New admin */}
      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="New admin"
        footer={
          <>
            <button type="button" onClick={() => setCreating(false)} className="btn-ghost">
              Cancel
            </button>
            <button
              type="button"
              onClick={() => create.mutate()}
              disabled={
                create.isPending ||
                !form.name ||
                !form.email ||
                form.password.length < 8 ||
                !form.roleId
              }
              className="btn-primary"
            >
              {create.isPending && <Spinner />}
              Create
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Name" htmlFor="a-name" required>
            <input
              id="a-name"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              className="input"
            />
          </Field>

          <Field label="Email" htmlFor="a-email" required>
            <input
              id="a-email"
              type="email"
              value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
              className="input"
            />
          </Field>

          <Field
            label="Password"
            htmlFor="a-password"
            required
            hint="At least 8 characters, including a letter and a number."
          >
            <input
              id="a-password"
              type="password"
              value={form.password}
              onChange={(event) => setForm({ ...form, password: event.target.value })}
              className="input"
            />
          </Field>

          <Field label="Role" htmlFor="a-role" required>
            <select
              id="a-role"
              value={form.roleId}
              onChange={(event) => setForm({ ...form, roleId: event.target.value })}
              className="input"
            >
              <option value="">Choose a role…</option>
              {roles.data?.roles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name} — {role.description}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Modal>

      {/* Role permissions */}
      <Modal
        open={Boolean(editingRole)}
        onClose={() => setEditingRole(null)}
        wide
        title={`Permissions — ${editingRole?.name}`}
        footer={
          <>
            <button type="button" onClick={() => setEditingRole(null)} className="btn-ghost">
              Cancel
            </button>
            <button
              type="button"
              onClick={() => editingRole && savePermissions.mutate(editingRole)}
              disabled={savePermissions.isPending}
              className="btn-primary"
            >
              {savePermissions.isPending && <Spinner />}
              Save permissions
            </button>
          </>
        }
      >
        {editingRole && (
          <div className="space-y-5">
            {Object.entries(permissionGroups).map(([group, permissions]) => (
              <div key={group}>
                <div className="mb-2 flex items-center justify-between">
                  <p className="eyebrow text-taupe">{group}</p>
                  <button
                    type="button"
                    onClick={() => {
                      const keys = permissions.map((permission) => permission.key)
                      const allOn = keys.every((key) => editingRole.permissions.includes(key))
                      setEditingRole({
                        ...editingRole,
                        permissions: allOn
                          ? editingRole.permissions.filter((key) => !keys.includes(key))
                          : Array.from(new Set([...editingRole.permissions, ...keys])),
                      })
                    }}
                    className="text-[0.625rem] uppercase tracking-[0.1em] text-taupe hover:text-charcoal"
                  >
                    Toggle all
                  </button>
                </div>

                <div className="grid gap-1.5 border border-line p-3 sm:grid-cols-2 lg:grid-cols-3">
                  {permissions.map((permission) => (
                    <label
                      key={permission.key}
                      className="flex cursor-pointer items-center gap-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={editingRole.permissions.includes(permission.key)}
                        onChange={(event) =>
                          setEditingRole({
                            ...editingRole,
                            permissions: event.target.checked
                              ? [...editingRole.permissions, permission.key]
                              : editingRole.permissions.filter((key) => key !== permission.key),
                          })
                        }
                        className="h-3.5 w-3.5"
                      />
                      <span className="text-mocha">{titleCase(permission.label)}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
        busy={remove.isPending}
        title={`Remove ${deleting?.name}?`}
        message="They will lose access immediately. Anything they changed stays in the audit log."
      />
    </>
  )
}
