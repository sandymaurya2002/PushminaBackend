import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Plus, Search, Trash2 } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import {
  Badge,
  Card,
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
import { cn, titleCase } from '@/lib/utils'

interface SeoEntry {
  id: string
  entityType: string
  entityId: string | null
  path: string | null
  title: string | null
  description: string | null
  keywords: string[]
  canonicalUrl: string | null
  ogImageUrl: string | null
  robotsIndex: boolean
  robotsFollow: boolean
  updatedAt: string
}

interface AuditData {
  issues: {
    productsWithoutImages: number
    imagesWithoutAltText: number
    productsWithoutDescription: Array<{ id: string; slug: string; name: string }>
    productsWithoutCustomSeo: number
    duplicateTitles: Array<{ title: string; count: number }>
  }
}

interface Redirect {
  id: string
  fromPath: string
  toPath: string
  statusCode: number
  isActive: boolean
  hitCount: number
}

export function Seo() {
  const [tab, setTab] = useState<'entries' | 'audit' | 'redirects'>('entries')
  const { can } = useAuth()
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const [editing, setEditing] = useState<SeoEntry | null>(null)
  const [redirectForm, setRedirectForm] = useState({ fromPath: '', toPath: '', statusCode: 301 })
  const [addingRedirect, setAddingRedirect] = useState(false)

  const entries = useQuery({
    queryKey: ['admin-seo'],
    queryFn: async () => (await api.get<SeoEntry[]>('/admin/seo', { limit: 200 })).data,
    enabled: tab === 'entries',
  })

  const audit = useQuery({
    queryKey: ['admin-seo-audit'],
    queryFn: async () => (await api.get<AuditData>('/admin/seo/audit')).data,
    enabled: tab === 'audit',
  })

  const redirects = useQuery({
    queryKey: ['admin-redirects'],
    queryFn: async () => (await api.get<Redirect[]>('/admin/seo/redirects')).data,
    enabled: tab === 'redirects',
  })

  const saveEntry = useMutation({
    mutationFn: async (entry: SeoEntry) => {
      const { id, updatedAt: _updatedAt, ...rest } = entry
      return api.put('/admin/seo', id ? { id, ...rest } : rest)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-seo'] })
      setEditing(null)
      toast({ title: 'SEO saved' })
    },
    onError: (caught) =>
      toast({
        title: 'Could not save',
        description: caught instanceof ApiError ? caught.message : 'Unexpected error.',
        tone: 'error',
      }),
  })

  const addRedirect = useMutation({
    mutationFn: async () => api.post('/admin/seo/redirects', redirectForm),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-redirects'] })
      setAddingRedirect(false)
      setRedirectForm({ fromPath: '', toPath: '', statusCode: 301 })
      toast({ title: 'Redirect added' })
    },
    onError: (caught) =>
      toast({
        title: 'Could not add',
        description: caught instanceof ApiError ? caught.message : 'Unexpected error.',
        tone: 'error',
      }),
  })

  const removeRedirect = useMutation({
    mutationFn: async (id: string) => api.delete(`/admin/seo/redirects/${id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['admin-redirects'] }),
  })

  const removeEntry = useMutation({
    mutationFn: async (id: string) => api.delete(`/admin/seo/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-seo'] })
      toast({ title: 'Override removed', description: 'The page uses its own defaults again.' })
    },
    onError: (caught) =>
      toast({
        title: 'Could not remove',
        description: caught instanceof ApiError ? caught.message : 'Unexpected error.',
        tone: 'error',
      }),
  })

  const newEntry = (): SeoEntry => ({
    id: '',
    entityType: 'PAGE',
    entityId: null,
    path: '/',
    title: '',
    description: '',
    keywords: [],
    canonicalUrl: null,
    ogImageUrl: null,
    robotsIndex: true,
    robotsFollow: true,
    updatedAt: '',
  })

  return (
    <>
      <PageHeader
        title="SEO"
        description="Titles, descriptions, canonical URLs and robots directives. Anything left blank falls back to the page's own content."
        actions={
          can('seo.update') &&
          (tab === 'redirects' ? (
            <button type="button" onClick={() => setAddingRedirect(true)} className="btn-primary">
              <Plus className="h-3.5 w-3.5" strokeWidth={2} />
              New redirect
            </button>
          ) : tab === 'entries' ? (
            <button type="button" onClick={() => setEditing(newEntry())} className="btn-primary">
              <Plus className="h-3.5 w-3.5" strokeWidth={2} />
              New override
            </button>
          ) : null)
        }
      />

      <div className="mb-6 flex gap-1 border-b border-line">
        {(['entries', 'audit', 'redirects'] as const).map((entry) => (
          <button
            key={entry}
            type="button"
            onClick={() => setTab(entry)}
            className={cn(
              'relative px-4 py-2.5 text-[0.75rem] uppercase tracking-[0.12em] transition-colors',
              tab === entry ? 'text-charcoal' : 'text-taupe hover:text-charcoal',
            )}
          >
            {entry === 'entries' ? 'Overrides' : entry === 'audit' ? 'Health check' : 'Redirects'}
            {tab === entry && (
              <span className="absolute inset-x-0 -bottom-px h-0.5 bg-gold" aria-hidden />
            )}
          </button>
        ))}
      </div>

      {tab === 'entries' && (
        <Card>
          {entries.isLoading ? (
            <LoadingBlock rows={6} />
          ) : entries.error ? (
            <ErrorState error={entries.error} retry={() => void entries.refetch()} />
          ) : !entries.data?.length ? (
            <EmptyState
              icon={<Search className="h-6 w-6" strokeWidth={1} />}
              title="No overrides yet"
              description="Every page already has sensible defaults derived from its content. Add an override only where you want something different."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[44rem]">
                <thead>
                  <tr>
                    <th className="th">Path</th>
                    <th className="th">Type</th>
                    <th className="th">Title</th>
                    <th className="th">Description</th>
                    <th className="th">Robots</th>
                    <th className="th w-28 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.data.map((entry) => (
                    <tr key={entry.id} className="transition-colors hover:bg-cream/40">
                      <td className="td">
                        <code className="text-[0.6875rem] text-mocha">{entry.path}</code>
                      </td>
                      <td className="td">
                        <Badge className="border-line-strong text-mocha">
                          {titleCase(entry.entityType)}
                        </Badge>
                      </td>
                      <td className="td">
                        <span className="block max-w-xs truncate text-charcoal">
                          {entry.title ?? '—'}
                        </span>
                        {entry.title && entry.title.length > 60 && (
                          <span className="text-[0.625rem] text-gold">
                            {entry.title.length} chars — may be truncated
                          </span>
                        )}
                      </td>
                      <td className="td">
                        <span className="block max-w-sm truncate text-xs text-mocha">
                          {entry.description ?? '—'}
                        </span>
                      </td>
                      <td className="td text-xs text-mocha">
                        {entry.robotsIndex ? 'index' : 'noindex'},{' '}
                        {entry.robotsFollow ? 'follow' : 'nofollow'}
                      </td>
                      <td className="td text-right">
                        {can('seo.update') && (
                          <div className="flex justify-end gap-3">
                            <button
                              type="button"
                              onClick={() => setEditing(entry)}
                              className="text-[0.6875rem] uppercase tracking-[0.1em] text-taupe hover:text-charcoal"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => removeEntry.mutate(entry.id)}
                              disabled={removeEntry.isPending}
                              aria-label={`Remove override for ${entry.path}`}
                              className="text-taupe hover:text-burgundy"
                            >
                              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'audit' && (
        <Card>
          {audit.isLoading ? (
            <LoadingBlock rows={5} />
          ) : audit.error ? (
            <ErrorState error={audit.error} retry={() => void audit.refetch()} />
          ) : audit.data ? (
            <ul className="divide-y divide-line">
              {[
                {
                  label: 'Published products with no images',
                  value: audit.data.issues.productsWithoutImages,
                  bad: audit.data.issues.productsWithoutImages > 0,
                },
                {
                  label: 'Images with no alt text',
                  value: audit.data.issues.imagesWithoutAltText,
                  bad: audit.data.issues.imagesWithoutAltText > 0,
                },
                {
                  label: 'Products with no description',
                  value: audit.data.issues.productsWithoutDescription.length,
                  bad: audit.data.issues.productsWithoutDescription.length > 0,
                },
                {
                  label: 'Products using default SEO',
                  value: audit.data.issues.productsWithoutCustomSeo,
                  bad: false,
                },
                {
                  label: 'Duplicate meta titles',
                  value: audit.data.issues.duplicateTitles.length,
                  bad: audit.data.issues.duplicateTitles.length > 0,
                },
              ].map((issue) => (
                <li key={issue.label} className="flex items-center justify-between px-5 py-4">
                  <span className="flex items-center gap-2.5 text-sm text-charcoal">
                    {issue.bad && (
                      <AlertTriangle className="h-4 w-4 text-gold" strokeWidth={1.5} />
                    )}
                    {issue.label}
                  </span>
                  <span
                    className={cn(
                      'font-serif text-xl',
                      issue.bad ? 'text-gold' : 'text-success',
                    )}
                  >
                    {issue.value}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
      )}

      {tab === 'redirects' && (
        <Card>
          {redirects.isLoading ? (
            <LoadingBlock rows={4} />
          ) : !redirects.data?.length ? (
            <EmptyState
              title="No redirects"
              description="Add one when you rename a slug, so the old URL keeps working and its search authority is preserved."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[36rem]">
                <thead>
                  <tr>
                    <th className="th">From</th>
                    <th className="th">To</th>
                    <th className="th">Type</th>
                    <th className="th text-right">Hits</th>
                    <th className="th w-16 text-right" />
                  </tr>
                </thead>
                <tbody>
                  {redirects.data.map((redirect) => (
                    <tr key={redirect.id} className="transition-colors hover:bg-cream/40">
                      <td className="td">
                        <code className="text-xs text-charcoal">{redirect.fromPath}</code>
                      </td>
                      <td className="td">
                        <code className="text-xs text-mocha">{redirect.toPath}</code>
                      </td>
                      <td className="td text-mocha">{redirect.statusCode}</td>
                      <td className="td text-right tabular-nums text-mocha">
                        {redirect.hitCount}
                      </td>
                      <td className="td text-right">
                        {can('seo.update') && (
                          <button
                            type="button"
                            onClick={() => removeRedirect.mutate(redirect.id)}
                            aria-label="Delete redirect"
                            className="p-1.5 text-taupe transition-colors hover:text-burgundy"
                          >
                            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* Edit override */}
      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        wide
        title={editing?.id ? 'Edit SEO' : 'New SEO override'}
        footer={
          <>
            <button type="button" onClick={() => setEditing(null)} className="btn-ghost">
              Cancel
            </button>
            <button
              type="button"
              onClick={() => editing && saveEntry.mutate(editing)}
              disabled={saveEntry.isPending}
              className="btn-primary"
            >
              {saveEntry.isPending && <Spinner />}
              Save
            </button>
          </>
        }
      >
        {editing && (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
              <Field label="Page path" htmlFor="s-path" required hint="The storefront address, e.g. /collections/pure-pashmina or /about.">
                <input
                  id="s-path"
                  value={editing.path ?? ''}
                  onChange={(event) => setEditing({ ...editing, path: event.target.value })}
                  className="input font-mono"
                  placeholder="/collections/pure-pashmina"
                />
              </Field>
              <Field label="Page type" htmlFor="s-type">
                <select
                  id="s-type"
                  value={editing.entityType}
                  onChange={(event) => setEditing({ ...editing, entityType: event.target.value })}
                  className="input"
                >
                  {['PAGE', 'PRODUCT', 'COLLECTION', 'CATEGORY', 'OTHER'].map((type) => (
                    <option key={type} value={type}>
                      {titleCase(type)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <Field
              label="Meta title"
              htmlFor="s-title"
              hint={`${editing.title?.length ?? 0} characters — around 60 is usually shown in full.`}
            >
              <input
                id="s-title"
                value={editing.title ?? ''}
                onChange={(event) => setEditing({ ...editing, title: event.target.value })}
                className="input"
              />
            </Field>

            <Field
              label="Meta description"
              htmlFor="s-desc"
              hint={`${editing.description?.length ?? 0} characters — aim for 70 to 158.`}
            >
              <textarea
                id="s-desc"
                rows={3}
                value={editing.description ?? ''}
                onChange={(event) => setEditing({ ...editing, description: event.target.value })}
                className="input h-auto py-2"
              />
            </Field>

            <Field label="Canonical URL" htmlFor="s-canonical">
              <input
                id="s-canonical"
                value={editing.canonicalUrl ?? ''}
                onChange={(event) => setEditing({ ...editing, canonicalUrl: event.target.value })}
                className="input"
                placeholder="Defaults to the page's own URL"
              />
            </Field>

            <Field label="Social sharing image" htmlFor="s-og">
              <input
                id="s-og"
                value={editing.ogImageUrl ?? ''}
                onChange={(event) => setEditing({ ...editing, ogImageUrl: event.target.value })}
                className="input"
              />
            </Field>

            <div className="flex flex-wrap gap-6">
              <Toggle
                checked={editing.robotsIndex}
                onChange={(next) => setEditing({ ...editing, robotsIndex: next })}
                label="Allow indexing"
                description="Turn off to keep this page out of search results."
              />
              <Toggle
                checked={editing.robotsFollow}
                onChange={(next) => setEditing({ ...editing, robotsFollow: next })}
                label="Follow links"
              />
            </div>

            {/* Live preview of how it will appear in search results. */}
            <div className="border border-line bg-cream/30 p-4">
              <p className="eyebrow mb-3 text-taupe">Search preview</p>
              <p className="text-[1.0625rem] leading-snug text-[#1a0dab]">
                {(editing.title ?? 'Untitled').slice(0, 60)}
                {(editing.title?.length ?? 0) > 60 && '…'}
              </p>
              <p className="mt-0.5 text-xs text-[#006621]">
                {editing.canonicalUrl || `https://www.pashmore.com${editing.path ?? ''}`}
              </p>
              <p className="mt-1 text-[0.8125rem] leading-snug text-[#545454]">
                {(editing.description ?? 'No description set.').slice(0, 158)}
                {(editing.description?.length ?? 0) > 158 && '…'}
              </p>
            </div>
          </div>
        )}
      </Modal>

      {/* Add redirect */}
      <Modal
        open={addingRedirect}
        onClose={() => setAddingRedirect(false)}
        title="New redirect"
        footer={
          <>
            <button type="button" onClick={() => setAddingRedirect(false)} className="btn-ghost">
              Cancel
            </button>
            <button
              type="button"
              onClick={() => addRedirect.mutate()}
              disabled={addRedirect.isPending || !redirectForm.fromPath || !redirectForm.toPath}
              className="btn-primary"
            >
              {addRedirect.isPending && <Spinner />}
              Add
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="From path" htmlFor="r-from" required hint="Must start with /">
            <input
              id="r-from"
              value={redirectForm.fromPath}
              onChange={(event) =>
                setRedirectForm({ ...redirectForm, fromPath: event.target.value })
              }
              className="input font-mono"
              placeholder="/collections/old-slug"
            />
          </Field>

          <Field label="To path" htmlFor="r-to" required>
            <input
              id="r-to"
              value={redirectForm.toPath}
              onChange={(event) => setRedirectForm({ ...redirectForm, toPath: event.target.value })}
              className="input font-mono"
              placeholder="/collections/new-slug"
            />
          </Field>

          <Field label="Type" htmlFor="r-type">
            <select
              id="r-type"
              value={redirectForm.statusCode}
              onChange={(event) =>
                setRedirectForm({ ...redirectForm, statusCode: Number(event.target.value) })
              }
              className="input"
            >
              <option value={301}>301 — permanent</option>
              <option value={302}>302 — temporary</option>
              <option value={308}>308 — permanent, keeps the method</option>
            </select>
          </Field>
        </div>
      </Modal>
    </>
  )
}
