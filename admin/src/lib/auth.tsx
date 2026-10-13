import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { api, getAccessToken, setAccessToken, setRefreshToken } from './api'

export interface AdminUser {
  id: string
  email: string
  name: string
  avatarUrl: string | null
  role: { id: string; name: string; slug: string }
  permissions: string[]
}

interface AuthContextValue {
  admin: AdminUser | null
  loading: boolean
  signIn: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>
  /** Super Admin always passes, so a new permission cannot lock the owner out. */
  can: (permission: string) => boolean
  canAny: (...permissions: string[]) => boolean
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [admin, setAdmin] = useState<AdminUser | null>(null)
  const [loading, setLoading] = useState(true)

  /* Restore the session on load: a stored access token may still be valid, and
     if it is not, the refresh cookie usually is. */
  useEffect(() => {
    let cancelled = false

    async function restore() {
      if (!getAccessToken()) {
        setLoading(false)
        return
      }
      try {
        const { data } = await api.get<AdminUser & { permissions: string[] }>('/admin/auth/me')
        if (!cancelled) setAdmin(data)
      } catch {
        if (!cancelled) setAccessToken(null)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void restore()
    return () => {
      cancelled = true
    }
  }, [])

  // The API client dispatches this when a refresh fails irrecoverably.
  useEffect(() => {
    const onExpired = () => setAdmin(null)
    window.addEventListener('pushmina:session-expired', onExpired)
    return () => window.removeEventListener('pushmina:session-expired', onExpired)
  }, [])

  const signIn = useCallback(async (email: string, password: string) => {
    const { data } = await api.login(email, password)
    setAccessToken(data.tokens.accessToken)
    setRefreshToken(data.tokens.refreshToken)
    setAdmin(data.admin)
  }, [])

  const signOut = useCallback(async () => {
    try {
      await api.logout()
    } finally {
      setAccessToken(null)
      setRefreshToken(null)
      setAdmin(null)
    }
  }, [])

  const can = useCallback(
    (permission: string) => {
      if (!admin) return false
      if (admin.role.slug === 'super-admin') return true
      return admin.permissions.includes(permission)
    },
    [admin],
  )

  const canAny = useCallback(
    (...permissions: string[]) => permissions.some((permission) => can(permission)),
    [can],
  )

  const value = useMemo(
    () => ({ admin, loading, signIn, signOut, can, canAny }),
    [admin, loading, signIn, signOut, can, canAny],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>')
  return context
}
