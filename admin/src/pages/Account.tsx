import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { KeyRound } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { Card, Field, PageHeader, Spinner, useToast } from '@/components/ui'
import { useAuth } from '@/lib/auth'

/** Mirrors the API's rules for admin passwords. */
const MIN_ADMIN_PASSWORD = 12

function errorMessage(caught: unknown): string {
  if (!(caught instanceof ApiError)) return 'Could not change your password.'
  const detail = caught.details?.newPassword ?? caught.details?.currentPassword
  return detail ?? caught.message
}

export function Account() {
  const { admin, signOut } = useAuth()
  const { toast } = useToast()
  const navigate = useNavigate()

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)

  const change = useMutation({
    mutationFn: async () =>
      api.post('/admin/auth/change-password', { currentPassword, newPassword }),
    onSuccess: async () => {
      toast({
        title: 'Password changed',
        description: 'You have been signed out everywhere. Please sign in again.',
      })
      // Changing a password revokes every session, including this one.
      await signOut()
      navigate('/login', { replace: true })
    },
    onError: (caught) => setError(errorMessage(caught)),
  })

  function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)

    if (newPassword !== confirmPassword) {
      setError('The new passwords do not match.')
      return
    }
    if (newPassword.length < MIN_ADMIN_PASSWORD) {
      setError(`Admin passwords need at least ${MIN_ADMIN_PASSWORD} characters.`)
      return
    }
    if (!/[A-Za-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      setError('Include at least one letter and one number.')
      return
    }
    if (newPassword === currentPassword) {
      setError('The new password must be different from the current one.')
      return
    }

    change.mutate()
  }

  return (
    <>
      <PageHeader title="Your account" description={`${admin?.name} · ${admin?.role.name}`} />

      <div className="max-w-lg space-y-6">
        <Card title="Details">
          <dl className="space-y-3 px-5 py-4 text-sm">
            <div>
              <dt className="eyebrow text-taupe">Name</dt>
              <dd className="mt-0.5 text-charcoal">{admin?.name}</dd>
            </div>
            <div>
              <dt className="eyebrow text-taupe">Email</dt>
              <dd className="mt-0.5 break-all text-charcoal">{admin?.email}</dd>
            </div>
            <div>
              <dt className="eyebrow text-taupe">Role</dt>
              <dd className="mt-0.5 text-charcoal">{admin?.role.name}</dd>
            </div>
            <div>
              <dt className="eyebrow text-taupe">Permissions</dt>
              <dd className="mt-0.5 text-charcoal">
                {admin?.role.slug === 'super-admin'
                  ? 'All permissions'
                  : `${admin?.permissions.length} granted`}
              </dd>
            </div>
          </dl>
        </Card>

        <Card title="Change password">
          <form onSubmit={onSubmit} noValidate className="space-y-4 p-5">
            <Field label="Current password" htmlFor="current" required>
              <input
                id="current"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                className="input"
              />
            </Field>

            <Field
              label="New password"
              htmlFor="new"
              required
              hint={`At least ${MIN_ADMIN_PASSWORD} characters, including a letter and a number.`}
            >
              <input
                id="new"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                className="input"
              />
            </Field>

            <Field label="Confirm new password" htmlFor="confirm" required>
              <input
                id="confirm"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                className="input"
              />
            </Field>

            {error && (
              <p
                role="alert"
                className="border border-burgundy/30 bg-burgundy/5 px-4 py-3 text-sm text-burgundy"
              >
                {error}
              </p>
            )}

            <p className="text-xs leading-relaxed text-taupe">
              Changing your password signs you out on every device, including this one.
            </p>

            <button
              type="submit"
              disabled={change.isPending || !currentPassword || !newPassword}
              className="btn-primary"
            >
              {change.isPending ? (
                <Spinner />
              ) : (
                <KeyRound className="h-3.5 w-3.5" strokeWidth={1.5} />
              )}
              Change password
            </button>
          </form>
        </Card>
      </div>
    </>
  )
}
