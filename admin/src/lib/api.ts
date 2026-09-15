/**
 * API client.
 *
 * Owns three things the rest of the app should not have to think about:
 *   1. Attaching the access token.
 *   2. Refreshing it transparently when it expires, retrying the original
 *      request once so the user never sees a spurious "session expired".
 *   3. Unwrapping the `{ success, data, meta }` envelope into plain data,
 *      and turning `{ success: false, error }` into a thrown ApiError.
 */

const BASE = '/api/v1'

let accessToken: string | null = localStorage.getItem('pushmina_admin_token')

export function setAccessToken(token: string | null): void {
  accessToken = token
  if (token) localStorage.setItem('pushmina_admin_token', token)
  else localStorage.removeItem('pushmina_admin_token')
}

export function getAccessToken(): string | null {
  return accessToken
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    /** Field-keyed messages from a validation failure, for form binding. */
    readonly details?: Record<string, string>,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export interface ApiMeta {
  page?: number
  limit?: number
  total?: number
  totalPages?: number
  hasNext?: boolean
  hasPrev?: boolean
  [key: string]: unknown
}

export interface ApiResult<T> {
  data: T
  meta?: ApiMeta
}

/* ------------------------------------------------------------------ *
 * Token refresh
 *
 * Concurrent 401s share one in-flight refresh. Without this, ten parallel
 * requests on a dashboard would each fire their own refresh, and because the
 * backend rotates refresh tokens single-use, nine of them would fail and log
 * the user out.
 * ------------------------------------------------------------------ */

let refreshInFlight: Promise<boolean> | null = null

async function refreshAccessToken(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight

  refreshInFlight = (async () => {
    try {
      const response = await fetch(`${BASE}/admin/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })

      if (!response.ok) return false

      const body = (await response.json()) as { data?: { tokens?: { accessToken: string } } }
      const token = body.data?.tokens?.accessToken
      if (!token) return false

      setAccessToken(token)
      return true
    } catch {
      return false
    } finally {
      refreshInFlight = null
    }
  })()

  return refreshInFlight
}

/** Broadcast so AuthProvider can clear state without a circular import. */
function signalSessionExpired(): void {
  setAccessToken(null)
  window.dispatchEvent(new CustomEvent('pushmina:session-expired'))
}

/* ------------------------------------------------------------------ *
 * Request
 * ------------------------------------------------------------------ */

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown
  /** Set false on the login call, which must not attempt a refresh. */
  retryOnUnauthorised?: boolean
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<ApiResult<T>> {
  const { body, retryOnUnauthorised = true, headers, ...rest } = options

  const isFormData = body instanceof FormData

  const send = async (): Promise<Response> =>
    fetch(`${BASE}${path}`, {
      ...rest,
      credentials: 'include',
      headers: {
        ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...headers,
      },
      body: isFormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
    })

  let response = await send()

  if (response.status === 401 && retryOnUnauthorised && accessToken) {
    const refreshed = await refreshAccessToken()
    if (refreshed) {
      response = await send()
    } else {
      signalSessionExpired()
      throw new ApiError('Your session has expired. Please sign in again.', 401, 'UNAUTHORIZED')
    }
  }

  if (response.status === 204) return { data: undefined as T }

  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    if (!response.ok) {
      throw new ApiError(`Request failed (${response.status})`, response.status, 'HTTP_ERROR')
    }
    return { data: (await response.text()) as T }
  }

  const payload = (await response.json()) as {
    success: boolean
    data?: T
    meta?: ApiMeta
    error?: { code: string; message: string; details?: Record<string, string> }
  }

  if (!response.ok || !payload.success) {
    if (response.status === 401) signalSessionExpired()
    throw new ApiError(
      payload.error?.message ?? 'Something went wrong.',
      response.status,
      payload.error?.code ?? 'UNKNOWN',
      payload.error?.details,
    )
  }

  return { data: payload.data as T, meta: payload.meta }
}

/* ------------------------------------------------------------------ *
 * Public surface
 * ------------------------------------------------------------------ */

function toQueryString(params?: Record<string, unknown>): string {
  if (!params) return ''
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) {
      if (value.length) search.set(key, value.join(','))
    } else {
      search.set(key, String(value))
    }
  }
  const query = search.toString()
  return query ? `?${query}` : ''
}

export const api = {
  get: <T>(path: string, params?: Record<string, unknown>) =>
    request<T>(`${path}${toQueryString(params)}`),

  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),

  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),

  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body }),

  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),

  upload: <T>(path: string, formData: FormData) =>
    request<T>(path, { method: 'POST', body: formData }),

  /** Login must not trigger a refresh loop when credentials are simply wrong. */
  login: (email: string, password: string) =>
    request<{
      admin: {
        id: string
        email: string
        name: string
        avatarUrl: string | null
        role: { id: string; name: string; slug: string }
        permissions: string[]
      }
      tokens: { accessToken: string; refreshToken: string }
    }>('/admin/auth/login', {
      method: 'POST',
      body: { email, password },
      retryOnUnauthorised: false,
    }),

  /** Triggers a browser download for CSV exports. */
  download: async (path: string, params?: Record<string, unknown>) => {
    const response = await fetch(`${BASE}${path}${toQueryString(params)}`, {
      credentials: 'include',
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    })
    if (!response.ok) throw new ApiError('Export failed', response.status, 'EXPORT_FAILED')

    const blob = await response.blob()
    const disposition = response.headers.get('content-disposition') ?? ''
    const match = /filename="([^"]+)"/.exec(disposition)

    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = match?.[1] ?? 'export.csv'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
  },
}
