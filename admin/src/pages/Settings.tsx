import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Save } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import {
  Card,
  ErrorState,
  Field,
  LoadingBlock,
  PageHeader,
  Spinner,
  useToast,
} from '@/components/ui'
import { useAuth } from '@/lib/auth'
import { titleCase } from '@/lib/utils'

interface Setting {
  key: string
  value: unknown
  group: string
  label: string | null
}

/**
 * Site settings.
 *
 * Values are typed JSON, so a setting may be a string, a number, a list (the
 * announcement bar) or an object (the workshop address). The editor picks a
 * control based on the current value's shape rather than requiring a schema
 * for every key.
 */
export function Settings() {
  const { can } = useAuth()
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<Record<string, unknown>>({})

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin-settings'],
    queryFn: async () => (await api.get<Setting[]>('/admin/content/settings')).data,
  })

  const save = useMutation({
    mutationFn: async () => {
      const settings = Object.entries(draft).map(([key, value]) => ({ key, value }))
      return api.put('/admin/content/settings', { settings })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-settings'] })
      setDraft({})
      toast({ title: 'Settings saved', description: 'The website has been updated.' })
    },
    onError: (caught) =>
      toast({
        title: 'Could not save',
        description: caught instanceof ApiError ? caught.message : 'Unexpected error.',
        tone: 'error',
      }),
  })

  if (isLoading) return <LoadingBlock rows={10} />
  if (error) return <ErrorState error={error} retry={() => void refetch()} />
  if (!data) return null

  const groups = data.reduce<Record<string, Setting[]>>((acc, setting) => {
    if (!acc[setting.group]) acc[setting.group] = []
    acc[setting.group].push(setting)
    return acc
  }, {})

  const current = (setting: Setting): unknown =>
    setting.key in draft ? draft[setting.key] : setting.value

  const dirty = Object.keys(draft).length > 0

  function renderControl(setting: Setting) {
    const value = current(setting)

    // A list — announcement bar lines, popular searches. One entry per line.
    if (Array.isArray(value)) {
      const isObjectList = value.some((entry) => typeof entry === 'object' && entry !== null)
      if (isObjectList) {
        return (
          <textarea
            id={setting.key}
            rows={5}
            value={JSON.stringify(value, null, 2)}
            onChange={(event) => {
              try {
                setDraft({ ...draft, [setting.key]: JSON.parse(event.target.value) })
              } catch {
                // Keep the invalid text in the box; it is simply not committed
                // until it parses.
              }
            }}
            className="input h-auto py-2 font-mono text-xs"
          />
        )
      }

      return (
        <textarea
          id={setting.key}
          rows={Math.max(3, value.length)}
          value={(value as string[]).join('\n')}
          onChange={(event) =>
            setDraft({
              ...draft,
              [setting.key]: event.target.value.split('\n').filter((line) => line.trim()),
            })
          }
          className="input h-auto py-2"
        />
      )
    }

    if (typeof value === 'object' && value !== null) {
      return (
        <textarea
          id={setting.key}
          rows={6}
          value={JSON.stringify(value, null, 2)}
          onChange={(event) => {
            try {
              setDraft({ ...draft, [setting.key]: JSON.parse(event.target.value) })
            } catch {
              /* not committed until valid */
            }
          }}
          className="input h-auto py-2 font-mono text-xs"
        />
      )
    }

    if (typeof value === 'number') {
      return (
        <input
          id={setting.key}
          type="number"
          step="any"
          value={String(value)}
          onChange={(event) => setDraft({ ...draft, [setting.key]: Number(event.target.value) })}
          className="input"
        />
      )
    }

    const isLong = typeof value === 'string' && value.length > 80
    return isLong ? (
      <textarea
        id={setting.key}
        rows={3}
        value={String(value)}
        onChange={(event) => setDraft({ ...draft, [setting.key]: event.target.value })}
        className="input h-auto py-2"
      />
    ) : (
      <input
        id={setting.key}
        value={String(value ?? '')}
        onChange={(event) => setDraft({ ...draft, [setting.key]: event.target.value })}
        className="input"
      />
    )
  }

  return (
    <>
      <PageHeader
        title="Settings"
        description="Brand details, contact information, the announcement bar and the commerce rules the storefront and checkout use."
        actions={
          can('settings.update') && (
            <button
              type="button"
              onClick={() => save.mutate()}
              disabled={!dirty || save.isPending}
              className="btn-primary"
            >
              {save.isPending ? <Spinner /> : <Save className="h-3.5 w-3.5" strokeWidth={1.5} />}
              {dirty ? `Save ${Object.keys(draft).length} change(s)` : 'Saved'}
            </button>
          )
        }
      />

      <div className="space-y-6">
        {Object.entries(groups).map(([group, settings]) => (
          <Card key={group} title={titleCase(group)}>
            <div className="grid gap-5 p-5 lg:grid-cols-2">
              {settings.map((setting) => (
                <Field
                  key={setting.key}
                  label={setting.label ?? titleCase(setting.key.split('.').pop() ?? setting.key)}
                  htmlFor={setting.key}
                  hint={setting.key}
                  className={
                    Array.isArray(setting.value) || typeof setting.value === 'object'
                      ? 'lg:col-span-2'
                      : undefined
                  }
                >
                  {renderControl(setting)}
                </Field>
              ))}
            </div>
          </Card>
        ))}
      </div>

      <p className="mt-6 text-xs leading-relaxed text-taupe">
        Commerce values — the free-shipping threshold, GST rate and cash-on-delivery limit — are
        applied by the checkout on the server. Changing them here changes what customers are
        charged.
      </p>
    </>
  )
}
