import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { GripVertical, Palette, Pencil, Plus, Trash2 } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import {
  Badge,
  Card,
  ConfirmDialog,
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
import { cn } from '@/lib/utils'

/**
 * Filters & Taxonomy.
 *
 * This is the vocabulary every storefront filter is built from. A colour added
 * here appears on the collection filter rails as soon as a product uses it —
 * swatch and all — with no deploy.
 */

type TabKey = 'colors' | 'sizes' | 'materials' | 'patterns' | 'categories'

interface TaxonomyRow {
  id: string
  name: string
  slug: string
  hex?: string
  measurement?: string | null
  description?: string | null
  gender?: string | null
  imageUrl?: string | null
  sortOrder: number
  isActive: boolean
  _count?: { products: number }
}

const TABS: Array<{ key: TabKey; label: string; endpoint: string; hint: string }> = [
  {
    key: 'colors',
    label: 'Colours',
    endpoint: '/admin/taxonomy/colors',
    hint: 'Swatch colours shown on the filter rail and product page. The hex value is what customers actually see.',
  },
  {
    key: 'sizes',
    label: 'Sizes',
    endpoint: '/admin/taxonomy/sizes',
    hint: 'Dimensions such as “Shawl — 100 × 200 cm”. The measurement appears under Size & Fit on the product page.',
  },
  {
    key: 'materials',
    label: 'Materials',
    endpoint: '/admin/taxonomy/materials',
    hint: 'Pure Pashmina, Cashmere, Fine Merino Wool and so on. Shown above the product name on every card.',
  },
  {
    key: 'patterns',
    label: 'Patterns',
    endpoint: '/admin/taxonomy/patterns',
    hint: 'Sozni, Kani, Jamawar, Solid… the craft technique used as a filter facet.',
  },
  {
    key: 'categories',
    label: 'Categories',
    endpoint: '/admin/taxonomy/categories',
    hint: 'The primary category of a product. Drives breadcrumbs and the canonical collection.',
  },
]

const PERMISSION = {
  colors: 'taxonomy',
  sizes: 'taxonomy',
  materials: 'taxonomy',
  patterns: 'taxonomy',
  categories: 'categories',
} as const

export function Taxonomy() {
  const [tab, setTab] = useState<TabKey>('colors')
  const [editing, setEditing] = useState<TaxonomyRow | null>(null)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<TaxonomyRow | null>(null)

  const { can } = useAuth()
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const active = TABS.find((entry) => entry.key === tab)!
  const permissionRoot = PERMISSION[tab]

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['taxonomy', tab],
    queryFn: async () => {
      const result = await api.get<TaxonomyRow[]>(active.endpoint, { limit: 200 })
      return result.data
    },
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['taxonomy', tab] })
    // The public filter vocabulary changes too.
    void queryClient.invalidateQueries({ queryKey: ['taxonomy-options'] })
  }

  const saveMutation = useMutation({
    mutationFn: async (input: Partial<TaxonomyRow> & { id?: string }) => {
      const { id, ...body } = input
      return id
        ? (await api.patch(`${active.endpoint}/${id}`, body)).data
        : (await api.post(active.endpoint, body)).data
    },
    onSuccess: (_result, variables) => {
      invalidate()
      setEditing(null)
      setCreating(false)
      toast({
        title: variables.id ? 'Saved' : 'Created',
        description: `${variables.name} is now live on the storefront filters.`,
      })
    },
    onError: (caught) => {
      toast({
        title: 'Could not save',
        description: caught instanceof ApiError ? caught.message : 'Unexpected error.',
        tone: 'error',
      })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => api.delete(`${active.endpoint}/${id}`),
    onSuccess: () => {
      invalidate()
      setDeleting(null)
      toast({ title: 'Deleted' })
    },
    onError: (caught) => {
      setDeleting(null)
      toast({
        title: 'Could not delete',
        description: caught instanceof ApiError ? caught.message : 'Unexpected error.',
        tone: 'error',
      })
    },
  })

  const toggleActive = useMutation({
    mutationFn: async (row: TaxonomyRow) =>
      api.patch(`${active.endpoint}/${row.id}`, { isActive: !row.isActive }),
    onSuccess: () => invalidate(),
  })

  return (
    <>
      <PageHeader
        title="Filters & Taxonomy"
        description="The vocabulary behind every filter on the website. Changes here appear on the storefront immediately."
        actions={
          can(`${permissionRoot}.create`) && (
            <button type="button" onClick={() => setCreating(true)} className="btn-primary">
              <Plus className="h-3.5 w-3.5" strokeWidth={2} />
              New {active.label.replace(/s$/, '').toLowerCase()}
            </button>
          )
        }
      />

      <div className="mb-6 flex flex-wrap gap-1 border-b border-line">
        {TABS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            onClick={() => setTab(entry.key)}
            className={cn(
              'relative px-4 py-2.5 text-[0.75rem] uppercase tracking-[0.12em] transition-colors',
              tab === entry.key ? 'text-charcoal' : 'text-taupe hover:text-charcoal',
            )}
          >
            {entry.label}
            {tab === entry.key && (
              <span className="absolute inset-x-0 -bottom-px h-0.5 bg-gold" aria-hidden />
            )}
          </button>
        ))}
      </div>

      <p className="mb-4 max-w-3xl text-sm leading-relaxed text-mocha">{active.hint}</p>

      <Card>
        {isLoading ? (
          <LoadingBlock />
        ) : error ? (
          <ErrorState error={error} retry={() => void refetch()} />
        ) : !data || data.length === 0 ? (
          <EmptyState
            icon={<Palette className="h-6 w-6" strokeWidth={1} />}
            title={`No ${active.label.toLowerCase()} yet`}
            description="Add the first one and it will become available as a filter on the website."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[42rem]">
              <thead>
                <tr>
                  <th className="th w-10" />
                  {tab === 'colors' && <th className="th w-16">Swatch</th>}
                  <th className="th">Name</th>
                  <th className="th">Slug (filter key)</th>
                  {tab === 'sizes' && <th className="th">Measurement</th>}
                  {tab === 'categories' && <th className="th">Gender</th>}
                  <th className="th text-right">Products</th>
                  <th className="th text-center">Active</th>
                  <th className="th w-24 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.map((row) => (
                  <tr key={row.id} className="transition-colors hover:bg-cream/40">
                    <td className="td text-taupe">
                      <GripVertical className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
                    </td>

                    {tab === 'colors' && (
                      <td className="td">
                        <span
                          className="block h-7 w-7 rounded-full border border-black/10"
                          style={{ backgroundColor: row.hex }}
                          title={row.hex}
                          aria-label={`Swatch ${row.hex}`}
                        />
                      </td>
                    )}

                    <td className="td text-charcoal">{row.name}</td>

                    <td className="td">
                      <code className="bg-cream px-1.5 py-0.5 text-[0.6875rem] text-mocha">
                        {row.slug}
                      </code>
                    </td>

                    {tab === 'sizes' && (
                      <td className="td text-mocha">{row.measurement ?? '—'}</td>
                    )}

                    {tab === 'categories' && (
                      <td className="td text-mocha">
                        {row.gender ? row.gender.toLowerCase() : '—'}
                      </td>
                    )}

                    <td className="td text-right tabular-nums text-mocha">
                      {row._count?.products ?? 0}
                    </td>

                    <td className="td text-center">
                      <button
                        type="button"
                        disabled={!can(`${permissionRoot}.update`)}
                        onClick={() => toggleActive.mutate(row)}
                        className="inline-flex"
                        aria-label={row.isActive ? 'Deactivate' : 'Activate'}
                      >
                        <Badge
                          className={
                            row.isActive
                              ? 'border-success/40 text-success'
                              : 'border-line-strong text-taupe'
                          }
                        >
                          {row.isActive ? 'Live' : 'Hidden'}
                        </Badge>
                      </button>
                    </td>

                    <td className="td">
                      <div className="flex justify-end gap-1">
                        {can(`${permissionRoot}.update`) && (
                          <button
                            type="button"
                            onClick={() => setEditing(row)}
                            aria-label={`Edit ${row.name}`}
                            className="p-1.5 text-taupe transition-colors hover:text-charcoal"
                          >
                            <Pencil className="h-3.5 w-3.5" strokeWidth={1.5} />
                          </button>
                        )}
                        {can(`${permissionRoot}.delete`) && (
                          <button
                            type="button"
                            onClick={() => setDeleting(row)}
                            aria-label={`Delete ${row.name}`}
                            className="p-1.5 text-taupe transition-colors hover:text-burgundy"
                          >
                            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <TaxonomyModal
        tab={tab}
        open={creating || Boolean(editing)}
        row={editing}
        busy={saveMutation.isPending}
        onClose={() => {
          setCreating(false)
          setEditing(null)
        }}
        onSave={(values) => saveMutation.mutate({ ...values, id: editing?.id })}
      />

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && deleteMutation.mutate(deleting.id)}
        busy={deleteMutation.isPending}
        title={`Delete ${deleting?.name}?`}
        message={
          (deleting?._count?.products ?? 0) > 0
            ? `${deleting?.name} is used by ${deleting?._count?.products} product(s), so it cannot be deleted. Deactivate it instead to hide it from the filters.`
            : 'This removes it from the storefront filters permanently. Products are not affected.'
        }
      />
    </>
  )
}

/* ------------------------------------------------------------------ */

function TaxonomyModal({
  tab,
  open,
  row,
  busy,
  onClose,
  onSave,
}: {
  tab: TabKey
  open: boolean
  row: TaxonomyRow | null
  busy: boolean
  onClose: () => void
  onSave: (values: Record<string, unknown>) => void
}) {
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [hex, setHex] = useState('#C9B294')
  const [measurement, setMeasurement] = useState('')
  const [description, setDescription] = useState('')
  const [gender, setGender] = useState('')
  const [isActive, setIsActive] = useState(true)
  const [initialised, setInitialised] = useState(false)

  // Seed the form once per opening, so typing is never overwritten by a rerender.
  if (open && !initialised) {
    setName(row?.name ?? '')
    setSlug(row?.slug ?? '')
    setHex(row?.hex ?? '#C9B294')
    setMeasurement(row?.measurement ?? '')
    setDescription(row?.description ?? '')
    setGender(row?.gender ?? '')
    setIsActive(row?.isActive ?? true)
    setInitialised(true)
  }
  if (!open && initialised) setInitialised(false)

  function submit(event: React.FormEvent) {
    event.preventDefault()

    const values: Record<string, unknown> = { name, isActive }
    if (slug.trim()) values.slug = slug.trim()
    if (tab === 'colors') values.hex = hex
    if (tab === 'sizes') values.measurement = measurement || null
    if (tab === 'materials' || tab === 'patterns') values.description = description || null
    if (tab === 'categories') {
      values.description = description || null
      values.gender = gender || null
    }

    onSave(values)
  }

  const label = TABS.find((entry) => entry.key === tab)!.label.replace(/s$/, '')

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={row ? `Edit ${label.toLowerCase()}` : `New ${label.toLowerCase()}`}
      footer={
        <>
          <button type="button" onClick={onClose} className="btn-ghost">
            Cancel
          </button>
          <button type="submit" form="taxonomy-form" disabled={busy} className="btn-primary">
            {busy && <Spinner />}
            {row ? 'Save changes' : 'Create'}
          </button>
        </>
      }
    >
      <form id="taxonomy-form" onSubmit={submit} className="space-y-5">
        <Field label="Name" htmlFor="tx-name" required>
          <input
            id="tx-name"
            required
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="input"
            placeholder={tab === 'colors' ? 'Antique Gold' : 'Name'}
          />
        </Field>

        <Field
          label="Slug"
          htmlFor="tx-slug"
          hint="The filter key used in URLs. Generated from the name if left blank. Changing it breaks existing filter links."
        >
          <input
            id="tx-slug"
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            className="input"
            placeholder="auto-generated"
          />
        </Field>

        {tab === 'colors' && (
          <Field
            label="Swatch colour"
            htmlFor="tx-hex"
            required
            hint="This is the circle customers see on the filter rail and the product page."
          >
            <div className="flex items-center gap-3">
              <input
                type="color"
                value={hex}
                onChange={(event) => setHex(event.target.value)}
                className="h-10 w-14 cursor-pointer border border-line-strong bg-white p-1"
                aria-label="Pick colour"
              />
              <input
                id="tx-hex"
                required
                value={hex}
                onChange={(event) => setHex(event.target.value)}
                className="input font-mono"
                placeholder="#C9B294"
              />
              <span
                className="h-10 w-10 shrink-0 rounded-full border border-black/10"
                style={{ backgroundColor: hex }}
                aria-hidden
              />
            </div>
          </Field>
        )}

        {tab === 'sizes' && (
          <Field
            label="Measurement"
            htmlFor="tx-measure"
            hint="Shown under Size & Fit on the product page, e.g. 100 × 200 cm."
          >
            <input
              id="tx-measure"
              value={measurement}
              onChange={(event) => setMeasurement(event.target.value)}
              className="input"
              placeholder="100 × 200 cm"
            />
          </Field>
        )}

        {(tab === 'materials' || tab === 'patterns' || tab === 'categories') && (
          <Field label="Description" htmlFor="tx-desc">
            <textarea
              id="tx-desc"
              rows={3}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              className="input h-auto py-2"
            />
          </Field>
        )}

        {tab === 'categories' && (
          <Field label="Gender" htmlFor="tx-gender">
            <select
              id="tx-gender"
              value={gender}
              onChange={(event) => setGender(event.target.value)}
              className="input"
            >
              <option value="">Not specified</option>
              <option value="WOMEN">Women</option>
              <option value="MEN">Men</option>
              <option value="UNISEX">Unisex</option>
            </select>
          </Field>
        )}

        <Toggle
          checked={isActive}
          onChange={setIsActive}
          label="Show on the storefront"
          description="Turn off to hide it from the filters without deleting it."
        />
      </form>
    </Modal>
  )
}
