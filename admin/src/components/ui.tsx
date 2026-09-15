import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { AlertCircle, Check, Info, Loader2, X } from 'lucide-react'
import { cn } from '@/lib/utils'

/* ------------------------------------------------------------------ *
 * Layout primitives
 * ------------------------------------------------------------------ */

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: string
  actions?: ReactNode
}) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="font-serif text-3xl text-charcoal">{title}</h1>
        {description && <p className="mt-2 max-w-2xl text-sm text-mocha">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

export function Card({
  children,
  className,
  title,
  actions,
}: {
  children: ReactNode
  className?: string
  title?: string
  actions?: ReactNode
}) {
  return (
    <section className={cn('card', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          {title && <h2 className="font-serif text-lg text-charcoal">{title}</h2>}
          {actions}
        </header>
      )}
      {children}
    </section>
  )
}

export function Badge({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return <span className={cn('chip', className)}>{children}</span>
}

/* ------------------------------------------------------------------ *
 * States
 * ------------------------------------------------------------------ */

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('h-4 w-4 animate-spin', className)} aria-hidden />
}

export function LoadingBlock({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-5" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="skeleton h-10 w-full" />
      ))}
    </div>
  )
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string
  description?: string
  action?: ReactNode
  icon?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center px-6 py-16 text-center">
      {icon && (
        <span className="mb-5 flex h-14 w-14 items-center justify-center rounded-full border border-line text-taupe">
          {icon}
        </span>
      )}
      <h3 className="font-serif text-xl text-charcoal">{title}</h3>
      {description && <p className="mt-2 max-w-md text-sm text-mocha">{description}</p>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  )
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const message = error instanceof Error ? error.message : 'Something went wrong.'
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <AlertCircle className="mb-4 h-8 w-8 text-burgundy" strokeWidth={1.25} />
      <h3 className="font-serif text-lg text-charcoal">That did not load</h3>
      <p className="mt-2 max-w-md text-sm text-mocha">{message}</p>
      {retry && (
        <button type="button" onClick={retry} className="btn-outline btn-sm mt-5">
          Try again
        </button>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Form fields
 * ------------------------------------------------------------------ */

interface FieldProps {
  label: string
  htmlFor?: string
  error?: string
  hint?: string
  required?: boolean
  className?: string
  children: ReactNode
}

export function Field({
  label,
  htmlFor,
  error,
  hint,
  required,
  className,
  children,
}: FieldProps) {
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className="label">
        {label}
        {required && <span className="ml-1 text-burgundy">*</span>}
      </label>
      {children}
      {hint && !error && <p className="mt-1 text-xs text-taupe">{hint}</p>}
      {error && (
        <p role="alert" className="mt-1 text-xs text-burgundy">
          {error}
        </p>
      )}
    </div>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  description?: string
  disabled?: boolean
}) {
  return (
    <label
      className={cn(
        'flex items-start gap-3',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
      )}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors duration-300',
          checked ? 'bg-charcoal' : 'bg-line-strong',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform duration-300 ease-luxe',
            checked ? 'translate-x-[1.125rem]' : 'translate-x-0.5',
          )}
        />
      </button>
      <span>
        <span className="block text-sm text-charcoal">{label}</span>
        {description && <span className="block text-xs text-taupe">{description}</span>}
      </span>
    </label>
  )
}

/* ------------------------------------------------------------------ *
 * Modal
 * ------------------------------------------------------------------ */

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}) {
  // Escape closes, and the page behind must not scroll while it is open.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-ink/45 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          'relative flex max-h-[90vh] w-full flex-col bg-white shadow-2xl',
          wide ? 'max-w-4xl' : 'max-w-lg',
        )}
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="font-serif text-lg text-charcoal">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 text-taupe transition-colors hover:text-charcoal"
          >
            <X className="h-4 w-4" strokeWidth={1.5} />
          </button>
        </header>

        <div className="scrollbar-thin flex-1 overflow-y-auto px-5 py-5">{children}</div>

        {footer && (
          <footer className="flex justify-end gap-2 border-t border-line px-5 py-4">
            {footer}
          </footer>
        )}
      </div>
    </div>
  )
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = 'Delete',
  danger = true,
  busy,
}: {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  title: string
  message: string
  confirmLabel?: string
  danger?: boolean
  busy?: boolean
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <button type="button" onClick={onClose} className="btn-ghost">
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={danger ? 'btn-danger' : 'btn-primary'}
          >
            {busy && <Spinner />}
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-mocha">{message}</p>
    </Modal>
  )
}

/* ------------------------------------------------------------------ *
 * Toasts
 * ------------------------------------------------------------------ */

type ToastTone = 'success' | 'error' | 'info'

interface Toast {
  id: number
  title: string
  description?: string
  tone: ToastTone
}

interface ToastContextValue {
  toast: (input: { title: string; description?: string; tone?: ToastTone }) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

let toastId = 0

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((entry) => entry.id !== id))
  }, [])

  const toast = useCallback<ToastContextValue['toast']>(
    ({ title, description, tone = 'success' }) => {
      const id = ++toastId
      setToasts((current) => [...current.slice(-2), { id, title, description, tone }])
      setTimeout(() => dismiss(id), 4500)
    },
    [dismiss],
  )

  const value = useMemo(() => ({ toast }), [toast])

  const ICONS = { success: Check, error: X, info: Info }

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed bottom-6 right-6 z-[70] flex w-[min(24rem,calc(100vw-3rem))] flex-col gap-2"
      >
        {toasts.map((entry) => {
          const Icon = ICONS[entry.tone]
          return (
            <div
              key={entry.id}
              className="pointer-events-auto flex items-start gap-3 border border-line bg-white px-4 py-3 shadow-lg"
            >
              <span
                aria-hidden
                className={cn(
                  'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-ivory',
                  entry.tone === 'error' ? 'bg-burgundy' : 'bg-charcoal',
                )}
              >
                <Icon className="h-3 w-3" strokeWidth={2.5} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-charcoal">{entry.title}</p>
                {entry.description && (
                  <p className="mt-0.5 text-xs leading-relaxed text-mocha">{entry.description}</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => dismiss(entry.id)}
                aria-label="Dismiss"
                className="p-0.5 text-taupe transition-colors hover:text-charcoal"
              >
                <X className="h-3.5 w-3.5" strokeWidth={1.5} />
              </button>
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext)
  if (!context) throw new Error('useToast must be used inside <ToastProvider>')
  return context
}

/* ------------------------------------------------------------------ *
 * Pagination
 * ------------------------------------------------------------------ */

export function Pagination({
  page,
  totalPages,
  total,
  onChange,
}: {
  page: number
  totalPages: number
  total: number
  onChange: (page: number) => void
}) {
  if (totalPages <= 1) {
    return (
      <div className="flex items-center justify-between border-t border-line px-4 py-3 text-xs text-taupe">
        <span>{total} total</span>
      </div>
    )
  }

  return (
    <div className="flex items-center justify-between gap-4 border-t border-line px-4 py-3">
      <span className="text-xs text-taupe">
        Page {page} of {totalPages} · {total} total
      </span>
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={() => onChange(page - 1)}
          disabled={page <= 1}
          className="btn-outline btn-sm"
        >
          Previous
        </button>
        <button
          type="button"
          onClick={() => onChange(page + 1)}
          disabled={page >= totalPages}
          className="btn-outline btn-sm"
        >
          Next
        </button>
      </div>
    </div>
  )
}
