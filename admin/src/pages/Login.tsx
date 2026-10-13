import { useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { Lock } from 'lucide-react'
import { useAuth } from '@/lib/auth'
import { ApiError } from '@/lib/api'
import { Field, Spinner } from '@/components/ui'

export function Login() {
  const { admin, loading, signIn } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-ivory">
        <Spinner className="h-6 w-6 text-taupe" />
      </div>
    )
  }

  // Already signed in — return to wherever they were headed.
  if (admin) {
    const from = (location.state as { from?: { pathname: string } } | null)?.from?.pathname ?? '/'
    return <Navigate to={from} replace />
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)

    try {
      await signIn(email, password)
      const from = (location.state as { from?: { pathname: string } } | null)?.from?.pathname ?? '/'
      navigate(from, { replace: true })
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not reach the API. Please try again.',
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen bg-ivory">
      <div className="flex w-full items-center justify-center px-5 py-16 lg:w-1/2">
        <div className="w-full max-w-sm">
          <div className="flex items-center gap-4">
            <img src="/logo.png" alt="" width={64} height={64} className="h-16 w-16" />
            <p className="font-serif text-2xl tracking-[0.3em] text-charcoal">PUSHMINA</p>
          </div>
          <p className="eyebrow mt-8 text-gold">Administration</p>
          <h1 className="mt-4 font-serif text-3xl leading-tight text-charcoal">Sign in</h1>
          <p className="mt-3 text-sm leading-relaxed text-mocha">
            Manage the catalogue, orders, payments and content for pushmina.com.
          </p>

          <form onSubmit={onSubmit} noValidate className="mt-9 space-y-5">
            <Field label="Email" htmlFor="email" required>
              <input
                id="email"
                type="email"
                autoComplete="username"
                autoFocus
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="input"
                placeholder="admin@pushmina.com"
              />
            </Field>

            <Field label="Password" htmlFor="password" required>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="input"
                placeholder="••••••••"
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

            <button type="submit" disabled={submitting} className="btn-primary h-11 w-full">
              {submitting ? <Spinner /> : <Lock className="h-3.5 w-3.5" strokeWidth={1.5} />}
              {submitting ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <p className="mt-8 text-xs leading-relaxed text-taupe">
            Sessions expire after inactivity and every action is recorded in the audit log.
          </p>
        </div>
      </div>

      {/* Decorative panel, hidden from assistive technology. */}
      <div className="relative hidden bg-charcoal lg:block lg:w-1/2" aria-hidden>
        <div className="flex h-full flex-col justify-end p-14">
          <img src="/logo.png" alt="" width={512} height={512} className="mx-auto mb-auto mt-8 w-72 max-w-[60%] opacity-95" />
          <p className="eyebrow text-gold-soft">Since 1978</p>
          <p className="mt-5 max-w-md font-serif text-3xl leading-tight text-ivory">
            Timeless Indian craftsmanship, woven for modern luxury.
          </p>
          <p className="mt-6 max-w-sm text-sm leading-relaxed text-ivory/60">
            Handcrafted in Srinagar, Kashmir. Every piece signed by the weaver who made it.
          </p>
        </div>
      </div>
    </div>
  )
}
