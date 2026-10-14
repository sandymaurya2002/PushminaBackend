import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Film, Image as ImageIcon, Pencil, Plus, Trash2, Upload } from 'lucide-react'
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
import { cn, formatDateTime, titleCase } from '@/lib/utils'

interface Banner {
  id: string
  placement: string
  eyebrow: string | null
  heading: string
  subheading: string | null
  mediaType: 'IMAGE' | 'VIDEO'
  imageUrl: string | null
  mobileImageUrl: string | null
  imageAlt: string | null
  videoUrl: string | null
  previewUrl: string | null
  videoPreviewUrl: string | null
  href: string | null
  ctaLabel: string | null
  secondaryHref: string | null
  secondaryCtaLabel: string | null
  sortOrder: number
  isActive: boolean
  startsAt: string | null
  endsAt: string | null
}

interface HomepageSection {
  id: string
  key: string
  type: string
  heading: string | null
  subheading: string | null
  href: string | null
  linkLabel: string | null
  sortOrder: number
  isActive: boolean
}

interface UploadedAsset {
  path: string
  mimeType: string
}

const PLACEMENTS = [
  'HOME_HERO',
  'HOME_FEATURED',
  'HOME_GIFT_PACKAGING',
  'HOME_GIFTING',
  'HOME_CATEGORY_CARD',
  'HOME_EDITORIAL',
  'HOME_SOCIAL',
  'COLLECTION_HEADER',
  'ANNOUNCEMENT',
  'PROMO_STRIP',
]

const EMPTY_BANNER = {
  placement: 'HOME_HERO',
  eyebrow: '',
  heading: '',
  subheading: '',
  mediaType: 'IMAGE' as 'IMAGE' | 'VIDEO',
  imageUrl: '',
  mobileImageUrl: '',
  imageAlt: '',
  videoUrl: '',
  href: '',
  ctaLabel: '',
  secondaryHref: '',
  secondaryCtaLabel: '',
  sortOrder: 0,
  isActive: true,
  startsAt: '',
  endsAt: '',
}

type BannerForm = typeof EMPTY_BANNER
type MediaField = 'imageUrl' | 'mobileImageUrl' | 'videoUrl'

/** `<input type="datetime-local">` works in local time without a zone. */
function toLocalInput(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

function fromLocalInput(value: string): string | null {
  return value ? new Date(value).toISOString() : null
}

function scheduleLabel(banner: Banner): string | null {
  const now = Date.now()
  if (banner.startsAt && Date.parse(banner.startsAt) > now) return `Starts ${formatDateTime(banner.startsAt)}`
  if (banner.endsAt && Date.parse(banner.endsAt) <= now) return 'Ended'
  if (banner.endsAt) return `Until ${formatDateTime(banner.endsAt)}`
  return null
}

export function Content() {
  const [tab, setTab] = useState<'banners' | 'sections'>('banners')
  const { can } = useAuth()
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const [editing, setEditing] = useState<Banner | null>(null)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<Banner | null>(null)
  const [form, setForm] = useState<BannerForm>(EMPTY_BANNER)
  const [uploadTarget, setUploadTarget] = useState<MediaField>('imageUrl')
  const fileInput = useRef<HTMLInputElement>(null)

  const errorToast = (title: string) => (caught: unknown) =>
    toast({
      title,
      description: caught instanceof ApiError ? caught.message : 'Unexpected error.',
      tone: 'error',
    })

  const banners = useQuery({
    queryKey: ['admin-banners'],
    queryFn: async () => (await api.get<Banner[]>('/admin/content/banners')).data,
    enabled: tab === 'banners',
  })

  const sections = useQuery({
    queryKey: ['admin-homepage-sections'],
    queryFn: async () =>
      (await api.get<HomepageSection[]>('/admin/content/homepage-sections')).data,
    enabled: tab === 'sections',
  })

  const saveBanner = useMutation({
    mutationFn: async () => {
      const body = {
        ...form,
        eyebrow: form.eyebrow || null,
        subheading: form.subheading || null,
        imageUrl: form.imageUrl ? api.mediaPath(form.imageUrl) : null,
        mobileImageUrl: form.mobileImageUrl ? api.mediaPath(form.mobileImageUrl) : null,
        videoUrl: form.mediaType === 'VIDEO' && form.videoUrl ? api.mediaPath(form.videoUrl) : null,
        imageAlt: form.imageAlt || null,
        href: form.href || null,
        ctaLabel: form.ctaLabel || null,
        secondaryHref: form.secondaryHref || null,
        secondaryCtaLabel: form.secondaryCtaLabel || null,
        sortOrder: Number(form.sortOrder),
        startsAt: fromLocalInput(form.startsAt),
        endsAt: fromLocalInput(form.endsAt),
      }
      return editing
        ? api.patch(`/admin/content/banners/${editing.id}`, body)
        : api.post('/admin/content/banners', body)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-banners'] })
      setCreating(false)
      setEditing(null)
      toast({ title: editing ? 'Banner saved' : 'Banner created', description: 'The website updates within a minute.' })
    },
    onError: errorToast('Could not save'),
  })

  const toggleBanner = useMutation({
    mutationFn: async (banner: Banner) =>
      api.patch(`/admin/content/banners/${banner.id}`, { isActive: !banner.isActive }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['admin-banners'] }),
    onError: errorToast('Could not update'),
  })

  const deleteBanner = useMutation({
    mutationFn: async (id: string) => api.delete(`/admin/content/banners/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-banners'] })
      setDeleting(null)
      toast({ title: 'Banner deleted' })
    },
    onError: (caught) => {
      setDeleting(null)
      errorToast('Could not delete')(caught)
    },
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
      setForm((current) => ({ ...current, [uploadTarget]: asset.path }))
      toast({ title: 'Uploaded', description: asset.path })
    },
    onError: errorToast('Upload failed'),
  })

  const toggleSection = useMutation({
    mutationFn: async ({ id, isActive }: { id: string; isActive: boolean }) =>
      api.patch(`/admin/content/homepage-sections/${id}`, { isActive }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-homepage-sections'] })
    },
    onError: errorToast('Could not update'),
  })

  const reorderSections = useMutation({
    mutationFn: async (ids: string[]) =>
      api.post('/admin/content/homepage-sections/reorder', { ids }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-homepage-sections'] })
    },
    onError: errorToast('Could not reorder'),
  })

  function moveSection(index: number, direction: -1 | 1) {
    const list = sections.data
    if (!list) return
    const next = [...list]
    const target = index + direction
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    reorderSections.mutate(next.map((section) => section.id))
  }

  function openEdit(banner: Banner) {
    setForm({
      placement: banner.placement,
      eyebrow: banner.eyebrow ?? '',
      heading: banner.heading,
      subheading: banner.subheading ?? '',
      mediaType: banner.mediaType ?? 'IMAGE',
      imageUrl: banner.imageUrl ?? '',
      mobileImageUrl: banner.mobileImageUrl ?? '',
      imageAlt: banner.imageAlt ?? '',
      videoUrl: banner.videoUrl ?? '',
      href: banner.href ?? '',
      ctaLabel: banner.ctaLabel ?? '',
      secondaryHref: banner.secondaryHref ?? '',
      secondaryCtaLabel: banner.secondaryCtaLabel ?? '',
      sortOrder: banner.sortOrder,
      isActive: banner.isActive,
      startsAt: toLocalInput(banner.startsAt),
      endsAt: toLocalInput(banner.endsAt),
    })
    setEditing(banner)
  }

  function pickFile(target: MediaField) {
    setUploadTarget(target)
    if (fileInput.current) {
      fileInput.current.accept =
        target === 'videoUrl' ? 'video/mp4,video/webm' : 'image/jpeg,image/png,image/webp,image/avif'
      fileInput.current.click()
    }
  }

  const mediaInput = (field: MediaField, id: string, placeholder: string) => (
    <div className="flex gap-2">
      <input
        id={id}
        value={form[field]}
        onChange={(event) => setForm({ ...form, [field]: event.target.value })}
        className="input flex-1"
        placeholder={placeholder}
      />
      {can('media.upload') && (
        <button
          type="button"
          onClick={() => pickFile(field)}
          disabled={upload.isPending}
          className="btn-outline btn-sm shrink-0"
          aria-label="Upload a file"
        >
          {upload.isPending && uploadTarget === field ? <Spinner /> : <Upload className="h-3.5 w-3.5" strokeWidth={1.5} />}
        </button>
      )}
    </div>
  )

  return (
    <>
      <PageHeader
        title="Homepage & banners"
        description="What appears on the homepage, in what order, and the imagery or video behind it. Changes reach the website within a minute."
        actions={
          tab === 'banners' &&
          can('banners.create') && (
            <button
              type="button"
              onClick={() => {
                setForm(EMPTY_BANNER)
                setCreating(true)
              }}
              className="btn-primary"
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={2} />
              New banner
            </button>
          )
        }
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

      <div className="mb-6 flex gap-1 border-b border-line">
        {(['banners', 'sections'] as const).map((entry) => (
          <button
            key={entry}
            type="button"
            onClick={() => setTab(entry)}
            className={cn(
              'relative px-4 py-2.5 text-[0.75rem] uppercase tracking-[0.12em] transition-colors',
              tab === entry ? 'text-charcoal' : 'text-taupe hover:text-charcoal',
            )}
          >
            {entry === 'banners' ? 'Banners' : 'Page sections'}
            {tab === entry && (
              <span className="absolute inset-x-0 -bottom-px h-0.5 bg-gold" aria-hidden />
            )}
          </button>
        ))}
      </div>

      {tab === 'banners' ? (
        <Card>
          {banners.isLoading ? (
            <LoadingBlock rows={5} />
          ) : banners.error ? (
            <ErrorState error={banners.error} retry={() => void banners.refetch()} />
          ) : !banners.data?.length ? (
            <EmptyState
              icon={<ImageIcon className="h-6 w-6" strokeWidth={1} />}
              title="No banners"
              description="Add a hero, featured or gifting banner. Until you do, the website shows its built-in imagery."
            />
          ) : (
            <ul className="divide-y divide-line">
              {banners.data.map((banner) => {
                const schedule = scheduleLabel(banner)
                return (
                  <li key={banner.id} className="flex items-center gap-4 px-5 py-3.5">
                    <div className="relative h-14 w-20 shrink-0 overflow-hidden bg-ivory-deep">
                      {banner.mediaType === 'VIDEO' && banner.videoPreviewUrl ? (
                        <video src={banner.videoPreviewUrl} muted playsInline preload="metadata" className="h-full w-full object-cover" />
                      ) : (
                        banner.previewUrl && <img src={banner.previewUrl} alt="" className="h-full w-full object-cover" />
                      )}
                      {banner.mediaType === 'VIDEO' && (
                        <Film className="absolute bottom-1 right-1 h-3.5 w-3.5 text-ivory drop-shadow" strokeWidth={1.5} />
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm text-charcoal">{banner.heading}</p>
                        <Badge className="border-line-strong text-taupe">{titleCase(banner.placement)}</Badge>
                        {schedule && <Badge className="border-gold/50 text-gold">{schedule}</Badge>}
                      </div>
                      {banner.subheading && (
                        <p className="mt-0.5 truncate text-xs text-mocha">{banner.subheading}</p>
                      )}
                    </div>

                    {can('banners.update') ? (
                      <Toggle
                        checked={banner.isActive}
                        onChange={() => toggleBanner.mutate(banner)}
                        label={banner.isActive ? 'Active' : 'Inactive'}
                      />
                    ) : (
                      !banner.isActive && <Badge className="border-line-strong text-taupe">Inactive</Badge>
                    )}

                    <div className="flex shrink-0 gap-1">
                      {can('banners.update') && (
                        <button
                          type="button"
                          onClick={() => openEdit(banner)}
                          aria-label={`Edit ${banner.heading}`}
                          className="p-1.5 text-taupe transition-colors hover:text-charcoal"
                        >
                          <Pencil className="h-3.5 w-3.5" strokeWidth={1.5} />
                        </button>
                      )}
                      {can('banners.delete') && (
                        <button
                          type="button"
                          onClick={() => setDeleting(banner)}
                          aria-label={`Delete ${banner.heading}`}
                          className="p-1.5 text-taupe transition-colors hover:text-burgundy"
                        >
                          <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                        </button>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </Card>
      ) : (
        <Card>
          {sections.isLoading ? (
            <LoadingBlock rows={6} />
          ) : sections.error ? (
            <ErrorState error={sections.error} retry={() => void sections.refetch()} />
          ) : (
            <ul className="divide-y divide-line">
              {sections.data?.map((section, index) => (
                <li key={section.id} className="flex items-center gap-4 px-5 py-3.5">
                  <span className="w-6 text-center font-serif text-lg text-taupe">
                    {index + 1}
                  </span>

                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-charcoal">
                      {section.heading ?? titleCase(section.key)}
                    </p>
                    <p className="text-[0.6875rem] text-taupe">
                      {section.type}
                      {section.subheading && ` · ${section.subheading}`}
                    </p>
                  </div>

                  <Toggle
                    checked={section.isActive}
                    onChange={(next) =>
                      toggleSection.mutate({ id: section.id, isActive: next })
                    }
                    label={section.isActive ? 'Shown' : 'Hidden'}
                  />

                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => moveSection(index, -1)}
                      disabled={index === 0}
                      aria-label="Move up"
                      className="p-1.5 text-taupe transition-colors hover:text-charcoal disabled:opacity-30"
                    >
                      <ArrowUp className="h-3.5 w-3.5" strokeWidth={1.5} />
                    </button>
                    <button
                      type="button"
                      onClick={() => moveSection(index, 1)}
                      disabled={index === (sections.data?.length ?? 0) - 1}
                      aria-label="Move down"
                      className="p-1.5 text-taupe transition-colors hover:text-charcoal disabled:opacity-30"
                    >
                      <ArrowDown className="h-3.5 w-3.5" strokeWidth={1.5} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <Modal
        open={creating || Boolean(editing)}
        onClose={() => {
          setCreating(false)
          setEditing(null)
        }}
        wide
        title={editing ? 'Edit banner' : 'New banner'}
        footer={
          <>
            <button
              type="button"
              onClick={() => {
                setCreating(false)
                setEditing(null)
              }}
              className="btn-ghost"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => saveBanner.mutate()}
              disabled={saveBanner.isPending || upload.isPending || !form.heading}
              className="btn-primary"
            >
              {saveBanner.isPending && <Spinner />}
              {editing ? 'Save changes' : 'Create'}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Placement" htmlFor="b-placement" required>
              <select
                id="b-placement"
                value={form.placement}
                onChange={(event) => setForm({ ...form, placement: event.target.value })}
                className="input"
              >
                {PLACEMENTS.map((placement) => (
                  <option key={placement} value={placement}>
                    {titleCase(placement)}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Media" htmlFor="b-media">
              <select
                id="b-media"
                value={form.mediaType}
                onChange={(event) => setForm({ ...form, mediaType: event.target.value as 'IMAGE' | 'VIDEO' })}
                className="input"
              >
                <option value="IMAGE">Image</option>
                <option value="VIDEO">Video</option>
              </select>
            </Field>

            <Field label="Order" htmlFor="b-order">
              <input
                id="b-order"
                type="number"
                value={form.sortOrder}
                onChange={(event) => setForm({ ...form, sortOrder: Number(event.target.value) })}
                className="input"
              />
            </Field>
          </div>

          <Field label="Eyebrow" htmlFor="b-eyebrow" hint="Small uppercase line above the heading.">
            <input
              id="b-eyebrow"
              value={form.eyebrow}
              onChange={(event) => setForm({ ...form, eyebrow: event.target.value })}
              className="input"
            />
          </Field>

          <Field label="Heading" htmlFor="b-heading" required>
            <input
              id="b-heading"
              value={form.heading}
              onChange={(event) => setForm({ ...form, heading: event.target.value })}
              className="input"
            />
          </Field>

          <Field label="Subheading" htmlFor="b-sub">
            <textarea
              id="b-sub"
              rows={2}
              value={form.subheading}
              onChange={(event) => setForm({ ...form, subheading: event.target.value })}
              className="input h-auto py-2"
            />
          </Field>

          {form.mediaType === 'VIDEO' && (
            <Field label="Video" htmlFor="b-video" required hint="MP4 or WebM, up to 40 MB. Plays muted and looped; the image below is the poster.">
              {mediaInput('videoUrl', 'b-video', '/media/videos/…')}
            </Field>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={form.mediaType === 'VIDEO' ? 'Poster image' : 'Image'} htmlFor="b-image" hint="Upload, or a /images/… path or https:// URL.">
              {mediaInput('imageUrl', 'b-image', '/images/editorial/…')}
            </Field>

            <Field label="Mobile image" htmlFor="b-mobile" hint="Optional portrait crop for phones.">
              {mediaInput('mobileImageUrl', 'b-mobile', '/media/banners/…')}
            </Field>
          </div>

          <Field label="Image alt text" htmlFor="b-alt" hint="Describes the image for screen readers.">
            <input
              id="b-alt"
              value={form.imageAlt}
              onChange={(event) => setForm({ ...form, imageAlt: event.target.value })}
              className="input"
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Link" htmlFor="b-href">
              <input
                id="b-href"
                value={form.href}
                onChange={(event) => setForm({ ...form, href: event.target.value })}
                className="input"
                placeholder="/collections/pure-pashmina"
              />
            </Field>

            <Field label="Button label" htmlFor="b-cta">
              <input
                id="b-cta"
                value={form.ctaLabel}
                onChange={(event) => setForm({ ...form, ctaLabel: event.target.value })}
                className="input"
                placeholder="Explore Collection"
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Secondary link" htmlFor="b-href2">
              <input
                id="b-href2"
                value={form.secondaryHref}
                onChange={(event) => setForm({ ...form, secondaryHref: event.target.value })}
                className="input"
              />
            </Field>

            <Field label="Secondary button label" htmlFor="b-cta2">
              <input
                id="b-cta2"
                value={form.secondaryCtaLabel}
                onChange={(event) => setForm({ ...form, secondaryCtaLabel: event.target.value })}
                className="input"
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Show from" htmlFor="b-start" hint="Leave empty to show straight away.">
              <input
                id="b-start"
                type="datetime-local"
                value={form.startsAt}
                onChange={(event) => setForm({ ...form, startsAt: event.target.value })}
                className="input"
              />
            </Field>
            <Field label="Show until" htmlFor="b-end" hint="Leave empty to keep it up.">
              <input
                id="b-end"
                type="datetime-local"
                value={form.endsAt}
                onChange={(event) => setForm({ ...form, endsAt: event.target.value })}
                className="input"
              />
            </Field>
          </div>

          <Toggle
            checked={form.isActive}
            onChange={(next) => setForm({ ...form, isActive: next })}
            label="Active on the website"
          />
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && deleteBanner.mutate(deleting.id)}
        busy={deleteBanner.isPending}
        title="Delete this banner?"
        message="It will be removed from the website immediately. Uploaded files stay in the media library."
      />
    </>
  )
}
