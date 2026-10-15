import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowDown, ArrowUp, Pencil, Plus, Trash2, Upload } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import {
  Badge,
  Card,
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
import { titleCase } from '@/lib/utils'
import {
  MENU_SECTION_KEY,
  SECTION_SPECS,
  SEED_HEADINGS,
  type FieldSpec,
  type ItemField,
  type SectionField,
  type SectionItem,
  type SectionSpec,
} from '@/lib/homepage'

interface HomepageSection {
  id: string
  key: string
  type: string
  heading: string | null
  subheading: string | null
  eyebrow: string | null
  body: string | null
  imageUrl: string | null
  imageAlt: string | null
  href: string | null
  linkLabel: string | null
  secondaryHref: string | null
  secondaryLinkLabel: string | null
  items: SectionItem[]
  sortOrder: number
  isActive: boolean
}

interface BannerSummary {
  placement: string
  isActive: boolean
  imageUrl: string | null
  videoUrl: string | null
  startsAt: string | null
  endsAt: string | null
}

interface UploadedAsset {
  path: string
}

type FormValues = Partial<Record<SectionField, string>>

const ITEM_FIELD_ORDER: ItemField[] = ['eyebrow', 'heading', 'body', 'href', 'linkLabel', 'imageUrl', 'imageAlt']

const STOREFRONT_URL = (import.meta.env.VITE_STOREFRONT_URL ?? 'https://www.pashmore.com').replace(/\/+$/, '')

/** Thumbnail for a stored path: /images/… ship with the website, /media/… are uploads served by the API. */
function previewUrl(path: string | undefined): string | null {
  const value = path?.trim()
  if (!value) return null
  if (value.startsWith('/images/')) return `${STOREFRONT_URL}${value}`
  if (value.startsWith('/')) return api.absolute(value)
  return value
}

function savedValue(section: HomepageSection, field: SectionField): string {
  const value = section[field]?.trim() ?? ''
  if (field === 'heading' && SEED_HEADINGS.has(value)) return ''
  if (field === 'subheading' && value.startsWith('Placement:')) return ''
  return value
}

function initialValues(section: HomepageSection, spec: SectionSpec): FormValues {
  return Object.fromEntries(
    (Object.keys(spec.fields) as SectionField[]).map((field) => [
      field,
      savedValue(section, field) || spec.defaults[field] || '',
    ]),
  )
}

function initialItems(section: HomepageSection, spec: SectionSpec): SectionItem[] {
  const list = spec.items
  if (!list) return []
  const saved = section.items ?? []
  if (list.fixed) {
    return list.defaults.map((fallback) => {
      const entry = saved.find((item) => item.key === fallback.key) ?? {}
      const filled = Object.fromEntries(Object.entries(entry).filter(([, value]) => value))
      return { ...fallback, ...filled }
    })
  }
  return (saved.length ? saved : list.defaults).map((item) => ({ ...item }))
}

function cleanItem(item: SectionItem): SectionItem {
  const result: SectionItem = {}
  for (const [key, raw] of Object.entries(item) as Array<[keyof SectionItem, string | undefined]>) {
    const value = raw?.trim()
    if (!value) continue
    result[key] = key === 'imageUrl' ? api.mediaPath(value) : value
  }
  return result
}

function isLiveBanner(banner: BannerSummary, now = Date.now()): boolean {
  if (!banner.isActive || !(banner.imageUrl || banner.videoUrl)) return false
  if (banner.startsAt && Date.parse(banner.startsAt) > now) return false
  if (banner.endsAt && Date.parse(banner.endsAt) <= now) return false
  return true
}

export function Homepage() {
  const { can } = useAuth()
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const canEdit = can('content.update')

  const [editing, setEditing] = useState<HomepageSection | null>(null)
  const [values, setValues] = useState<FormValues>({})
  const [items, setItems] = useState<SectionItem[]>([])
  const [uploadTarget, setUploadTarget] = useState<string>('')
  const fileInput = useRef<HTMLInputElement>(null)

  const errorToast = (title: string) => (caught: unknown) =>
    toast({
      title,
      description: caught instanceof ApiError ? caught.message : 'Unexpected error.',
      tone: 'error',
    })

  const sections = useQuery({
    queryKey: ['admin-homepage-sections'],
    queryFn: async () => (await api.get<HomepageSection[]>('/admin/content/homepage-sections')).data,
  })

  const banners = useQuery({
    queryKey: ['admin-banners'],
    queryFn: async () => (await api.get<BannerSummary[]>('/admin/content/banners')).data,
    enabled: can('banners.view'),
  })

  const livePlacements = new Set((banners.data ?? []).filter((banner) => isLiveBanner(banner)).map((banner) => banner.placement))
  const blocks = (sections.data ?? []).filter((section) => section.key !== MENU_SECTION_KEY)
  const menu = sections.data?.find((section) => section.key === MENU_SECTION_KEY)
  const spec = editing ? SECTION_SPECS[editing.key] : undefined

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['admin-homepage-sections'] })

  const toggleSection = useMutation({
    mutationFn: async ({ id, isActive }: { id: string; isActive: boolean }) =>
      api.patch(`/admin/content/homepage-sections/${id}`, { isActive }),
    onSuccess: invalidate,
    onError: errorToast('Could not update'),
  })

  const reorderSections = useMutation({
    mutationFn: async (ids: string[]) => api.post('/admin/content/homepage-sections/reorder', { ids }),
    onSuccess: invalidate,
    onError: errorToast('Could not reorder'),
  })

  const saveSection = useMutation({
    mutationFn: async () => {
      if (!editing || !spec) return
      const body: Record<string, unknown> = {}
      for (const field of Object.keys(spec.fields) as SectionField[]) {
        const value = values[field]?.trim() ?? ''
        body[field] = value ? (field === 'imageUrl' ? api.mediaPath(value) : value) : null
      }
      if (spec.items) body.items = items.map(cleanItem)
      return api.patch(`/admin/content/homepage-sections/${editing.id}`, body)
    },
    onSuccess: () => {
      invalidate()
      setEditing(null)
      toast({ title: 'Saved', description: 'The website updates within a minute.' })
    },
    onError: errorToast('Could not save'),
  })

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData()
      formData.append('files', file)
      formData.append('folder', 'banners')
      return api.upload<UploadedAsset[]>('/admin/media', formData)
    },
    onSuccess: (result) => {
      const asset = result.data[0]
      if (!asset) return
      if (uploadTarget.startsWith('item:')) {
        const index = Number(uploadTarget.slice(5))
        setItems((current) => current.map((item, i) => (i === index ? { ...item, imageUrl: asset.path } : item)))
      } else {
        setValues((current) => ({ ...current, imageUrl: asset.path }))
      }
      toast({ title: 'Uploaded', description: asset.path })
    },
    onError: errorToast('Upload failed'),
  })

  function openSection(section: HomepageSection) {
    const sectionSpec = SECTION_SPECS[section.key]
    if (!sectionSpec) return
    setValues(initialValues(section, sectionSpec))
    setItems(initialItems(section, sectionSpec))
    setEditing(section)
  }

  function moveSection(index: number, direction: -1 | 1) {
    const target = index + direction
    if (target < 0 || target >= blocks.length) return
    const next = [...blocks]
    ;[next[index], next[target]] = [next[target], next[index]]
    reorderSections.mutate([...next.map((section) => section.id), ...(menu ? [menu.id] : [])])
  }

  function moveItem(index: number, direction: -1 | 1) {
    const target = index + direction
    if (target < 0 || target >= items.length) return
    const next = [...items]
    ;[next[index], next[target]] = [next[target], next[index]]
    setItems(next)
  }

  function pickImage(target: string) {
    setUploadTarget(target)
    if (fileInput.current) {
      fileInput.current.accept = 'image/jpeg,image/png,image/webp,image/avif'
      fileInput.current.click()
    }
  }

  const missing: string[] = []
  if (spec) {
    for (const [field, fieldSpec] of Object.entries(spec.fields) as Array<[SectionField, FieldSpec]>) {
      if (fieldSpec.required && !values[field]?.trim()) missing.push(fieldSpec.label)
    }
    items.forEach((item, index) => {
      for (const [field, fieldSpec] of Object.entries(spec.items?.fields ?? {}) as Array<[ItemField, FieldSpec]>) {
        if (fieldSpec.required && !item[field]?.trim()) missing.push(`${spec.items?.itemLabel} ${index + 1}: ${fieldSpec.label}`)
      }
    })
  }

  const imageInput = (id: string, value: string, onChange: (next: string) => void, target: string) => {
    const preview = previewUrl(value)
    return (
      <div className="flex items-start gap-3">
        <div className="h-14 w-14 shrink-0 overflow-hidden border border-line bg-ivory-deep">
          {preview && <img src={preview} alt="" className="h-full w-full object-cover" />}
        </div>
        <div className="flex flex-1 gap-2">
          <input
            id={id}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            className="input flex-1"
            placeholder="/images/… or upload"
          />
          {can('media.upload') && (
            <button
              type="button"
              onClick={() => pickImage(target)}
              disabled={upload.isPending}
              className="btn-outline btn-sm shrink-0"
              aria-label="Upload an image"
            >
              {upload.isPending && uploadTarget === target ? <Spinner /> : <Upload className="h-3.5 w-3.5" strokeWidth={1.5} />}
            </button>
          )}
        </div>
      </div>
    )
  }

  const textInput = (id: string, fieldSpec: FieldSpec, value: string, onChange: (next: string) => void) =>
    fieldSpec.long ? (
      <textarea
        id={id}
        rows={4}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="input h-auto py-2"
      />
    ) : (
      <input id={id} value={value} onChange={(event) => onChange(event.target.value)} className="input" />
    )

  const wide = (field: string, fieldSpec: FieldSpec) => fieldSpec.long || field === 'imageUrl' || field === 'imageAlt'

  return (
    <>
      <PageHeader
        title="Homepage"
        description="Edit the text, images and links of each homepage block, show or hide blocks, and change their order. Changes reach the website within a minute."
      />

      <input
        ref={fileInput}
        type="file"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) upload.mutate(file)
          event.target.value = ''
        }}
      />

      <Card title="Homepage blocks">
        {sections.isLoading ? (
          <LoadingBlock rows={8} />
        ) : sections.error ? (
          <ErrorState error={sections.error} retry={() => void sections.refetch()} />
        ) : (
          <ul className="divide-y divide-line">
            {blocks.map((section, index) => {
              const sectionSpec = SECTION_SPECS[section.key]
              const replaced = sectionSpec?.bannerPlacement && livePlacements.has(sectionSpec.bannerPlacement)
              return (
                <li key={section.id} className="flex items-center gap-4 px-5 py-3.5">
                  <span className="w-6 text-center font-serif text-lg text-taupe">{index + 1}</span>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm text-charcoal">
                        {sectionSpec?.label || savedValue(section, 'heading') || titleCase(section.key)}
                      </p>
                      {replaced && (
                        <Badge className="border-gold/50 text-gold">Replaced by a banner</Badge>
                      )}
                    </div>
                    <p className="text-[0.6875rem] text-taupe">
                      {sectionSpec?.description ?? 'Can be shown, hidden or moved.'}
                    </p>
                  </div>

                  {sectionSpec && canEdit && (
                    <button
                      type="button"
                      onClick={() => openSection(section)}
                      className="btn-outline btn-sm"
                    >
                      <Pencil className="h-3.5 w-3.5" strokeWidth={1.5} />
                      Edit
                    </button>
                  )}

                  <Toggle
                    checked={section.isActive}
                    disabled={!canEdit}
                    onChange={(next) => toggleSection.mutate({ id: section.id, isActive: next })}
                    label={section.isActive ? 'Shown' : 'Hidden'}
                  />

                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => moveSection(index, -1)}
                      disabled={!canEdit || index === 0 || reorderSections.isPending}
                      aria-label="Move up"
                      className="p-1.5 text-taupe transition-colors hover:text-charcoal disabled:opacity-30"
                    >
                      <ArrowUp className="h-3.5 w-3.5" strokeWidth={1.5} />
                    </button>
                    <button
                      type="button"
                      onClick={() => moveSection(index, 1)}
                      disabled={!canEdit || index === blocks.length - 1 || reorderSections.isPending}
                      aria-label="Move down"
                      className="p-1.5 text-taupe transition-colors hover:text-charcoal disabled:opacity-30"
                    >
                      <ArrowDown className="h-3.5 w-3.5" strokeWidth={1.5} />
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      {menu && (
        <Card title="Menu" className="mt-6">
          <div className="flex items-center gap-4 px-5 py-4">
            <div className="min-w-0 flex-1">
              <p className="text-sm text-charcoal">{SECTION_SPECS[MENU_SECTION_KEY].label}</p>
              <p className="text-[0.6875rem] text-taupe">{SECTION_SPECS[MENU_SECTION_KEY].description}</p>
            </div>
            {canEdit && (
              <button type="button" onClick={() => openSection(menu)} className="btn-outline btn-sm">
                <Pencil className="h-3.5 w-3.5" strokeWidth={1.5} />
                Edit
              </button>
            )}
          </div>
        </Card>
      )}

      <Modal
        open={Boolean(editing && spec)}
        onClose={() => setEditing(null)}
        wide
        title={spec?.label ?? 'Edit section'}
        footer={
          <>
            {missing.length > 0 && (
              <p className="mr-auto self-center text-xs text-burgundy">Required: {missing.join(', ')}</p>
            )}
            <button type="button" onClick={() => setEditing(null)} className="btn-ghost">
              Cancel
            </button>
            <button
              type="button"
              onClick={() => saveSection.mutate()}
              disabled={saveSection.isPending || upload.isPending || missing.length > 0}
              className="btn-primary"
            >
              {saveSection.isPending && <Spinner />}
              Save changes
            </button>
          </>
        }
      >
        {spec && (
          <div className="space-y-6">
            {spec.bannerPlacement && livePlacements.has(spec.bannerPlacement) && (
              <div className="flex gap-3 border border-gold/50 bg-gold/5 px-4 py-3 text-sm text-mocha">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-gold" strokeWidth={1.5} />
                <p>
                  An active banner with placement “{titleCase(spec.bannerPlacement)}” is shown instead of this block.
                  Turn that banner off under Website → Banners to see these changes on the website.
                </p>
              </div>
            )}

            {Object.keys(spec.fields).length > 0 && (
              <div className="grid gap-4 sm:grid-cols-2">
                {(Object.entries(spec.fields) as Array<[SectionField, FieldSpec]>).map(([field, fieldSpec]) => (
                  <Field
                    key={field}
                    label={fieldSpec.label}
                    htmlFor={`s-${field}`}
                    hint={fieldSpec.hint}
                    required={fieldSpec.required}
                    className={wide(field, fieldSpec) ? 'sm:col-span-2' : undefined}
                  >
                    {field === 'imageUrl'
                      ? imageInput(
                          `s-${field}`,
                          values.imageUrl ?? '',
                          (next) => setValues((current) => ({ ...current, imageUrl: next })),
                          'field',
                        )
                      : textInput(`s-${field}`, fieldSpec, values[field] ?? '', (next) =>
                          setValues((current) => ({ ...current, [field]: next })),
                        )}
                  </Field>
                ))}
              </div>
            )}

            {spec.items && (
              <div>
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="font-serif text-lg text-charcoal">{spec.items.title}</h3>
                  {!spec.items.fixed && items.length < spec.items.max && (
                    <button
                      type="button"
                      onClick={() => setItems((current) => [...current, {}])}
                      className="btn-outline btn-sm"
                    >
                      <Plus className="h-3.5 w-3.5" strokeWidth={2} />
                      Add {spec.items.itemLabel.toLowerCase()}
                    </button>
                  )}
                </div>

                <div className="space-y-4">
                  {items.map((item, index) => (
                    <div key={index} className="border border-line p-4">
                      <div className="mb-3 flex items-center justify-between">
                        <p className="text-[0.75rem] uppercase tracking-[0.12em] text-taupe">
                          {spec.items?.fixed ? `${item.key} menu` : `${spec.items?.itemLabel} ${index + 1}`}
                        </p>
                        {!spec.items?.fixed && (
                          <div className="flex gap-1">
                            <button
                              type="button"
                              onClick={() => moveItem(index, -1)}
                              disabled={index === 0}
                              aria-label="Move up"
                              className="p-1.5 text-taupe transition-colors hover:text-charcoal disabled:opacity-30"
                            >
                              <ArrowUp className="h-3.5 w-3.5" strokeWidth={1.5} />
                            </button>
                            <button
                              type="button"
                              onClick={() => moveItem(index, 1)}
                              disabled={index === items.length - 1}
                              aria-label="Move down"
                              className="p-1.5 text-taupe transition-colors hover:text-charcoal disabled:opacity-30"
                            >
                              <ArrowDown className="h-3.5 w-3.5" strokeWidth={1.5} />
                            </button>
                            <button
                              type="button"
                              onClick={() => setItems((current) => current.filter((_, i) => i !== index))}
                              disabled={items.length <= 1}
                              aria-label="Remove"
                              className="p-1.5 text-taupe transition-colors hover:text-burgundy disabled:opacity-30"
                            >
                              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                            </button>
                          </div>
                        )}
                      </div>

                      <div className="grid gap-4 sm:grid-cols-2">
                        {ITEM_FIELD_ORDER.filter((field) => spec.items?.fields[field]).map((field) => {
                          const fieldSpec = spec.items!.fields[field]!
                          const id = `i-${index}-${field}`
                          const update = (next: string) =>
                            setItems((current) => current.map((entry, i) => (i === index ? { ...entry, [field]: next } : entry)))
                          return (
                            <Field
                              key={field}
                              label={fieldSpec.label}
                              htmlFor={id}
                              hint={fieldSpec.hint}
                              required={fieldSpec.required}
                              className={wide(field, fieldSpec) ? 'sm:col-span-2' : undefined}
                            >
                              {field === 'imageUrl'
                                ? imageInput(id, item.imageUrl ?? '', update, `item:${index}`)
                                : textInput(id, fieldSpec, item[field] ?? '', update)}
                            </Field>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>
    </>
  )
}
