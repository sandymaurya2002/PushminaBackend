import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { KeyRound, Search } from 'lucide-react'
import { api, type ApiMeta } from '@/lib/api'
import { Badge, Card, EmptyState, ErrorState, LoadingBlock, PageHeader, Pagination } from '@/components/ui'
import { useAuth } from '@/lib/auth'
import { formatDateTime, titleCase } from '@/lib/utils'

export interface LoginEventEntry {
  id: string
  userId: string | null
  kind?: string
  event: string
  email: string | null
  name: string | null
  ip: string | null
  userAgent: string | null
  createdAt: string
}

const EVENTS = [
  'LOGIN',
  'LOGIN_FAILED',
  'LOGIN_LOCKED',
  'LOGOUT',
  'LOGOUT_ALL',
  'REGISTER',
  'PASSWORD_CHANGED',
  'PASSWORD_RESET_REQUESTED',
  'PASSWORD_RESET',
]

export const LOGIN_EVENT_TONE: Record<string, string> = {
  LOGIN: 'border-success/40 text-success',
  REGISTER: 'border-success/40 text-success',
  LOGIN_FAILED: 'border-burgundy/40 text-burgundy',
  LOGIN_LOCKED: 'border-burgundy/40 text-burgundy',
  PASSWORD_RESET: 'border-gold/50 text-gold',
  PASSWORD_CHANGED: 'border-gold/50 text-gold',
}

/** A short "Chrome on Windows" style summary of a user agent string. */
export function describeAgent(agent: string | null): string {
  if (!agent) return '—'
  const browser = /Edg\//.test(agent)
    ? 'Edge'
    : /OPR\//.test(agent)
      ? 'Opera'
      : /Chrome\//.test(agent)
        ? 'Chrome'
        : /Firefox\//.test(agent)
          ? 'Firefox'
          : /Safari\//.test(agent)
            ? 'Safari'
            : null
  const os = /Windows/.test(agent)
    ? 'Windows'
    : /Android/.test(agent)
      ? 'Android'
      : /iPhone|iPad/.test(agent)
        ? 'iOS'
        : /Mac OS X/.test(agent)
          ? 'macOS'
          : /Linux/.test(agent)
            ? 'Linux'
            : null
  if (!browser && !os) return agent.slice(0, 40)
  return [browser, os].filter(Boolean).join(' on ')
}

export function LoginActivity() {
  const [params, setParams] = useSearchParams()
  const { can } = useAuth()
  const [search, setSearch] = useState(params.get('q') ?? '')

  const filters = {
    q: params.get('q') ?? undefined,
    kind: params.get('kind') ?? undefined,
    event: params.get('event') ?? undefined,
    from: params.get('from') ?? undefined,
    to: params.get('to') ?? undefined,
    page: Number(params.get('page') ?? 1),
    limit: 50,
  }

  useEffect(() => {
    const timer = setTimeout(() => {
      const next = new URLSearchParams(params)
      if (search) next.set('q', search)
      else next.delete('q')
      next.delete('page')
      if (next.toString() !== params.toString()) setParams(next, { replace: true })
    }, 350)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin-login-activity', filters],
    queryFn: async () => {
      const result = await api.get<LoginEventEntry[]>('/admin/login-activity', filters)
      return { rows: result.data, meta: result.meta as ApiMeta }
    },
  })

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    next.delete('page')
    setParams(next)
  }

  return (
    <>
      <PageHeader
        title="Login activity"
        description="Sign-ins, failed attempts, registrations and password changes. Passwords and reset links are never recorded."
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[16rem] flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-taupe"
            strokeWidth={1.5}
            aria-hidden
          />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Email, name or IP address…"
            className="input pl-9"
            aria-label="Search login activity"
          />
        </div>

        {can('admins.view') && (
          <select
            value={params.get('kind') ?? ''}
            onChange={(event) => setFilter('kind', event.target.value)}
            className="input w-auto"
            aria-label="Account type"
          >
            <option value="">Customers and staff</option>
            <option value="CUSTOMER">Customers</option>
            <option value="ADMIN">Staff</option>
          </select>
        )}

        <select
          value={params.get('event') ?? ''}
          onChange={(event) => setFilter('event', event.target.value)}
          className="input w-auto"
          aria-label="Event"
        >
          <option value="">All events</option>
          {EVENTS.map((event) => (
            <option key={event} value={event}>
              {titleCase(event)}
            </option>
          ))}
        </select>

        <input
          type="date"
          value={params.get('from') ?? ''}
          onChange={(event) => setFilter('from', event.target.value)}
          className="input w-auto"
          aria-label="From date"
        />
        <input
          type="date"
          value={params.get('to') ?? ''}
          onChange={(event) => setFilter('to', event.target.value)}
          className="input w-auto"
          aria-label="To date"
        />
      </div>

      <Card>
        {isLoading ? (
          <LoadingBlock rows={8} />
        ) : error ? (
          <ErrorState error={error} retry={() => void refetch()} />
        ) : !data?.rows.length ? (
          <EmptyState
            icon={<KeyRound className="h-6 w-6" strokeWidth={1} />}
            title="No activity found"
            description="Sign-ins and account changes appear here as they happen."
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[48rem]">
                <thead>
                  <tr>
                    <th className="th">When</th>
                    <th className="th">Account</th>
                    <th className="th">Event</th>
                    <th className="th">IP address</th>
                    <th className="th">Device</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((entry) => (
                    <tr key={entry.id} className="transition-colors hover:bg-cream/40">
                      <td className="td whitespace-nowrap text-xs text-mocha">
                        {formatDateTime(entry.createdAt)}
                      </td>
                      <td className="td">
                        {entry.userId && entry.kind === 'CUSTOMER' ? (
                          <Link to={`/customers/${entry.userId}`} className="text-charcoal hover:text-gold">
                            {entry.name ?? entry.email ?? 'Customer'}
                          </Link>
                        ) : (
                          <span className="text-charcoal">{entry.name ?? entry.email ?? 'Unknown'}</span>
                        )}
                        <span className="block text-[0.6875rem] text-taupe">
                          {entry.name && entry.email ? `${entry.email} · ` : ''}
                          {entry.kind === 'ADMIN' ? 'Staff' : 'Customer'}
                        </span>
                      </td>
                      <td className="td">
                        <Badge className={LOGIN_EVENT_TONE[entry.event] ?? 'border-line-strong text-mocha'}>
                          {titleCase(entry.event)}
                        </Badge>
                      </td>
                      <td className="td font-mono text-xs text-mocha">{entry.ip ?? '—'}</td>
                      <td className="td text-xs text-mocha" title={entry.userAgent ?? undefined}>
                        {describeAgent(entry.userAgent)}
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
                const nextParams = new URLSearchParams(params)
                nextParams.set('page', String(next))
                setParams(nextParams)
              }}
            />
          </>
        )}
      </Card>
    </>
  )
}
