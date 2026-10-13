import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, Plus, Trash2, Upload } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import {
  Card,
  ErrorState,
  Field,
  LoadingBlock,
  PageHeader,
  Spinner,
  Toggle,
  useToast,
} from '@/components/ui'
import { useAuth } from '@/lib/auth'
import { cn, formatPrice, toSlug } from '@/lib/utils'

interface Variant {
  id?: string
  sku: string
  colorId: string | null
  sizeId: string | null
  price: number
  compareAtPrice: number | null
  inventory: number
  isActive: boolean
}

interface ProductImage {
  id?: string
  url: string
  alt: string
  width: number
  height: number
  isPrimary: boolean
}

const BADGES = ['NEW', 'BESTSELLER', 'LIMITED', 'HANDCRAFTED', 'EXCLUSIVE']

const EMPTY = {
  name: '',
  slug: '',
  tagline: '',
  description: '',
  story: '',
  gender: 'WOMEN',
  categoryId: '',
  materialId: '',
  patternId: '',
  craft: '',
  countryOfOrigin: 'India',
  weight: '',
  finish: '',
  price: '',
  compareAtPrice: '',
  costPrice: '',
  status: 'DRAFT',
  isFeatured: false,
  isTrending: false,
  isNewArrival: false,
  popularity: 50,
  lowStockThreshold: 6,
  careInstructions: '',
}

export function ProductForm() {
  const { id } = useParams<{ id: string }>()
  const isNew = !id || id === 'new'
  const navigate = useNavigate()
  const { can } = useAuth()
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const [tab, setTab] = useState<'details' | 'media' | 'variants' | 'organisation'>('details')
  const [form, setForm] = useState(EMPTY)
  const [colorIds, setColorIds] = useState<string[]>([])
  const [sizeIds, setSizeIds] = useState<string[]>([])
  const [collectionIds, setCollectionIds] = useState<string[]>([])
  const [badges, setBadges] = useState<string[]>([])
  const [images, setImages] = useState<ProductImage[]>([])
  const [variants, setVariants] = useState<Variant[]>([])
  const [specs, setSpecs] = useState<Array<{ label: string; value: string }>>([])
  const [faqs, setFaqs] = useState<Array<{ question: string; answer: string }>>([])
  const [seeded, setSeeded] = useState(false)

  const taxonomy = useQuery({
    queryKey: ['product-form-taxonomy'],
    queryFn: async () => {
      const [colors, sizes, materials, patterns, categories, collections] = await Promise.all([
        api.get<Array<{ id: string; name: string; hex: string }>>('/admin/taxonomy/colors', { limit: 200 }),
        api.get<Array<{ id: string; name: string }>>('/admin/taxonomy/sizes', { limit: 200 }),
        api.get<Array<{ id: string; name: string }>>('/admin/taxonomy/materials', { limit: 200 }),
        api.get<Array<{ id: string; name: string }>>('/admin/taxonomy/patterns', { limit: 200 }),
        api.get<Array<{ id: string; name: string }>>('/admin/taxonomy/categories'),
        api.get<Array<{ id: string; name: string; group: string }>>('/admin/content/collections', { limit: 200 }),
      ])
      return {
        colors: colors.data,
        sizes: sizes.data,
        materials: materials.data,
        patterns: patterns.data,
        categories: categories.data,
        collections: collections.data,
      }
    },
  })

  const product = useQuery({
    queryKey: ['admin-product', id],
    queryFn: async () => (await api.get<Record<string, never>>(`/admin/products/${id}`)).data,
    enabled: !isNew,
  })

  if (!isNew && product.data && !seeded) {
    const data = product.data as Record<string, never>
    const raw = data.raw as Record<string, never>

    setForm({
      name: String(data.name ?? ''),
      slug: String(data.slug ?? ''),
      tagline: String(data.tagline ?? ''),
      description: String(data.description ?? ''),
      story: ((data.story as unknown as string[]) ?? []).join('\n\n'),
      gender: String(raw.gender ?? 'WOMEN'),
      categoryId: String(raw.categoryId ?? ''),
      materialId: String(raw.materialId ?? ''),
      patternId: String(raw.patternId ?? ''),
      craft: String(data.craft ?? ''),
      countryOfOrigin: String(data.countryOfOrigin ?? 'India'),
      weight: String((data.specifications as unknown as Array<{ label: string; value: string }>)?.find((s) => s.label === 'Weight')?.value ?? ''),
      finish: String((data.specifications as unknown as Array<{ label: string; value: string }>)?.find((s) => s.label === 'Finish')?.value ?? ''),
      price: String(data.price ?? ''),
      compareAtPrice: data.compareAtPrice ? String(data.compareAtPrice) : '',
      costPrice: raw.costPrice ? String(raw.costPrice) : '',
      status: String(raw.status ?? 'DRAFT'),
      isFeatured: Boolean(data.isFeatured),
      isTrending: Boolean(data.isTrending),
      isNewArrival: Boolean(data.isNewArrival),
      popularity: Number(data.popularity ?? 50),
      lowStockThreshold: Number(raw.lowStockThreshold ?? 6),
      careInstructions: ((data.careInstructions as unknown as string[]) ?? []).join('\n'),
    })

    setColorIds((raw.colorIds as unknown as string[]) ?? [])
    setSizeIds((raw.sizeIds as unknown as string[]) ?? [])
    setCollectionIds((raw.collectionIds as unknown as string[]) ?? [])
    setBadges((raw.badges as unknown as string[]) ?? [])
    setImages(((raw.images as unknown as ProductImage[]) ?? []).map((image) => ({ ...image })))
    setVariants(
      ((raw.variants as unknown as Array<Record<string, never>>) ?? []).map((variant) => ({
        id: String(variant.id),
        sku: String(variant.sku),
        colorId: variant.colorId ? String(variant.colorId) : null,
        sizeId: variant.sizeId ? String(variant.sizeId) : null,
        price: Number(variant.price),
        compareAtPrice: variant.compareAtPrice ? Number(variant.compareAtPrice) : null,
        inventory: Number(variant.inventory),
        isActive: Boolean(variant.isActive),
      })),
    )
    setSpecs((data.specifications as unknown as Array<{ label: string; value: string }>) ?? [])
    setFaqs((data.faqs as unknown as Array<{ question: string; answer: string }>) ?? [])
    setSeeded(true)
  }

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name: form.name,
        slug: form.slug || undefined,
        tagline: form.tagline,
        description: form.description,
        story: form.story.split('\n\n').map((p) => p.trim()).filter(Boolean),
        gender: form.gender,
        categoryId: form.categoryId,
        materialId: form.materialId,
        patternId: form.patternId,
        craft: form.craft,
        countryOfOrigin: form.countryOfOrigin,
        weight: form.weight || null,
        finish: form.finish || null,
        price: Number(form.price),
        compareAtPrice: form.compareAtPrice ? Number(form.compareAtPrice) : null,
        costPrice: form.costPrice ? Number(form.costPrice) : null,
        status: form.status,
        isFeatured: form.isFeatured,
        isTrending: form.isTrending,
        isNewArrival: form.isNewArrival,
        popularity: Number(form.popularity),
        lowStockThreshold: Number(form.lowStockThreshold),
        careInstructions: form.careInstructions.split('\n').map((l) => l.trim()).filter(Boolean),
        colorIds,
        sizeIds,
        collectionIds,
        badges,
        relatedProductIds: [],
        images,
        variants,
        specifications: specs.filter((spec) => spec.label && spec.value),
        faqs: faqs.filter((faq) => faq.question && faq.answer),
      }

      return isNew
        ? api.post<{ id: string }>('/admin/products', body)
        : api.put<{ id: string }>(`/admin/products/${id}`, body)
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['admin-products'] })
      toast({ title: isNew ? 'Product created' : 'Product saved' })
      if (isNew) navigate(`/products/${result.data.id}`, { replace: true })
    },
    onError: (caught) =>
      toast({
        title: 'Could not save',
        description: caught instanceof ApiError ? caught.message : 'Unexpected error.',
        tone: 'error',
      }),
  })

  const [uploading, setUploading] = useState(false)

  /** Uploads to the private R2 bucket via the API, then attaches the returned /media/… paths. */
  async function uploadImages(files: File[]) {
    setUploading(true)
    try {
      const formData = new FormData()
      for (const file of files) formData.append('files', file)
      formData.append('folder', 'products')
      if (form.name) formData.append('alt', form.name)
      const { data } = await api.upload<Array<{ path: string; alt: string | null; width: number | null; height: number | null }>>(
        '/admin/media',
        formData,
      )
      setImages((current) => [
        ...current,
        ...data.map((asset, index) => ({
          url: asset.path,
          alt: asset.alt ?? form.name,
          width: asset.width ?? 1200,
          height: asset.height ?? 1500,
          isPrimary: current.length === 0 && index === 0,
        })),
      ])
      toast({ title: `${data.length} image(s) uploaded`, description: 'Save the product to keep them.' })
    } catch (caught) {
      toast({
        title: 'Upload failed',
        description: caught instanceof ApiError ? caught.message : 'Unexpected error.',
        tone: 'error',
      })
    } finally {
      setUploading(false)
    }
  }

  /**
   * Builds one variant per colour × size combination, preserving SKU and stock
   * for combinations that already exist so regenerating never wipes inventory.
   */
  function generateVariants() {
    const colours = colorIds.length ? colorIds : [null]
    const sizes = sizeIds.length ? sizeIds : [null]
    const next: Variant[] = []
    let index = 1

    for (const colorId of colours) {
      for (const sizeId of sizes) {
        const existing = variants.find(
          (variant) => variant.colorId === colorId && variant.sizeId === sizeId,
        )
        const colourName =
          taxonomy.data?.colors.find((colour) => colour.id === colorId)?.name ?? 'STD'
        const stem = toSlug(form.name || 'product')
          .split('-')
          .slice(0, 3)
          .map((word) => word.slice(0, 3).toUpperCase())
          .join('')

        next.push(
          existing ?? {
            sku: `PSH-${stem}-${colourName.slice(0, 3).toUpperCase()}-${String(index).padStart(2, '0')}`,
            colorId,
            sizeId,
            price: Number(form.price) || 0,
            compareAtPrice: form.compareAtPrice ? Number(form.compareAtPrice) : null,
            inventory: 0,
            isActive: true,
          },
        )
        index += 1
      }
    }

    setVariants(next)
    toast({ title: `${next.length} variant(s) ready`, description: 'Set the stock for each.' })
  }

  if (!isNew && product.isLoading) return <LoadingBlock rows={10} />
  if (!isNew && product.error) return <ErrorState error={product.error} />
  if (taxonomy.isLoading) return <LoadingBlock rows={10} />

  const readOnly = !can(isNew ? 'products.create' : 'products.update')
  const totalStock = variants.reduce((sum, variant) => sum + Number(variant.inventory || 0), 0)

  const TABS = [
    { key: 'details', label: 'Details' },
    { key: 'media', label: `Images (${images.length})` },
    { key: 'variants', label: `Variants (${variants.length})` },
    { key: 'organisation', label: 'Organisation' },
  ] as const

  return (
    <>
      <Link
        to="/products"
        className="mb-5 inline-flex items-center gap-1.5 text-[0.6875rem] uppercase tracking-[0.12em] text-taupe transition-colors hover:text-charcoal"
      >
        <ChevronLeft className="h-3.5 w-3.5" strokeWidth={1.5} />
        All products
      </Link>

      <PageHeader
        title={isNew ? 'New product' : form.name || 'Edit product'}
        description={!isNew ? `${totalStock} in stock across ${variants.length} variants` : undefined}
        actions={
          !readOnly && (
            <button
              type="button"
              onClick={() => save.mutate()}
              disabled={
                save.isPending ||
                !form.name ||
                !form.price ||
                !form.categoryId ||
                !form.materialId ||
                !form.patternId
              }
              className="btn-primary"
            >
              {save.isPending && <Spinner />}
              {isNew ? 'Create product' : 'Save changes'}
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

      {/* ---------------- Details ---------------- */}
      {tab === 'details' && (
        <div className="grid gap-6 xl:grid-cols-3">
          <div className="space-y-6 xl:col-span-2">
            <Card title="Basics">
              <div className="space-y-4 p-5">
                <Field label="Name" htmlFor="name" required>
                  <input
                    id="name"
                    value={form.name}
                    onChange={(event) => {
                      const name = event.target.value
                      setForm((current) => ({
                        ...current,
                        name,
                        slug: isNew && !current.slug ? toSlug(name) : current.slug,
                      }))
                    }}
                    className="input"
                    disabled={readOnly}
                  />
                </Field>

                <Field
                  label="URL slug"
                  htmlFor="slug"
                  hint="Changing this on a live product breaks existing links. Add a redirect if you do."
                >
                  <input
                    id="slug"
                    value={form.slug}
                    onChange={(event) => setForm({ ...form, slug: event.target.value })}
                    className="input font-mono text-xs"
                    disabled={readOnly}
                  />
                </Field>

                <Field label="Tagline" htmlFor="tagline" required hint="One editorial line used on cards.">
                  <input
                    id="tagline"
                    value={form.tagline}
                    onChange={(event) => setForm({ ...form, tagline: event.target.value })}
                    className="input"
                    disabled={readOnly}
                  />
                </Field>

                <Field label="Description" htmlFor="description" required>
                  <textarea
                    id="description"
                    rows={4}
                    value={form.description}
                    onChange={(event) => setForm({ ...form, description: event.target.value })}
                    className="input h-auto py-2"
                    disabled={readOnly}
                  />
                </Field>

                <Field
                  label="Story"
                  htmlFor="story"
                  hint="Long-form editorial paragraphs. Separate each with a blank line."
                >
                  <textarea
                    id="story"
                    rows={6}
                    value={form.story}
                    onChange={(event) => setForm({ ...form, story: event.target.value })}
                    className="input h-auto py-2"
                    disabled={readOnly}
                  />
                </Field>

                <Field label="Craft" htmlFor="craft" required>
                  <input
                    id="craft"
                    value={form.craft}
                    onChange={(event) => setForm({ ...form, craft: event.target.value })}
                    className="input"
                    placeholder="Hand-spun, handwoven on a wooden handloom"
                    disabled={readOnly}
                  />
                </Field>

                <Field
                  label="Care instructions"
                  htmlFor="care"
                  hint="One per line."
                >
                  <textarea
                    id="care"
                    rows={4}
                    value={form.careInstructions}
                    onChange={(event) => setForm({ ...form, careInstructions: event.target.value })}
                    className="input h-auto py-2"
                    disabled={readOnly}
                  />
                </Field>
              </div>
            </Card>

            <Card
              title="Specifications"
              actions={
                !readOnly && (
                  <button
                    type="button"
                    onClick={() => setSpecs([...specs, { label: '', value: '' }])}
                    className="btn-outline btn-sm"
                  >
                    <Plus className="h-3 w-3" strokeWidth={2} />
                    Add
                  </button>
                )
              }
            >
              <div className="space-y-2 p-5">
                {specs.length === 0 && (
                  <p className="py-4 text-center text-sm text-taupe">No specifications yet.</p>
                )}
                {specs.map((spec, index) => (
                  <div key={index} className="flex gap-2">
                    <input
                      value={spec.label}
                      onChange={(event) =>
                        setSpecs(
                          specs.map((entry, position) =>
                            position === index ? { ...entry, label: event.target.value } : entry,
                          ),
                        )
                      }
                      className="input w-1/3"
                      placeholder="Material"
                      disabled={readOnly}
                      aria-label="Specification label"
                    />
                    <input
                      value={spec.value}
                      onChange={(event) =>
                        setSpecs(
                          specs.map((entry, position) =>
                            position === index ? { ...entry, value: event.target.value } : entry,
                          ),
                        )
                      }
                      className="input flex-1"
                      placeholder="Pure Pashmina"
                      disabled={readOnly}
                      aria-label="Specification value"
                    />
                    <button
                      type="button"
                      onClick={() => setSpecs(specs.filter((_, position) => position !== index))}
                      disabled={readOnly}
                      aria-label="Remove specification"
                      className="p-2 text-taupe hover:text-burgundy"
                    >
                      <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                    </button>
                  </div>
                ))}
              </div>
            </Card>

            <Card
              title="FAQs"
              actions={
                !readOnly && (
                  <button
                    type="button"
                    onClick={() => setFaqs([...faqs, { question: '', answer: '' }])}
                    className="btn-outline btn-sm"
                  >
                    <Plus className="h-3 w-3" strokeWidth={2} />
                    Add
                  </button>
                )
              }
            >
              <div className="space-y-3 p-5">
                {faqs.length === 0 && (
                  <p className="py-4 text-center text-sm text-taupe">
                    No FAQs. These also produce FAQ structured data on the product page.
                  </p>
                )}
                {faqs.map((faq, index) => (
                  <div key={index} className="space-y-2 border border-line bg-cream/20 p-3">
                    <div className="flex gap-2">
                      <input
                        value={faq.question}
                        onChange={(event) =>
                          setFaqs(
                            faqs.map((entry, position) =>
                              position === index
                                ? { ...entry, question: event.target.value }
                                : entry,
                            ),
                          )
                        }
                        className="input flex-1"
                        placeholder="Question"
                        disabled={readOnly}
                        aria-label="Question"
                      />
                      <button
                        type="button"
                        onClick={() => setFaqs(faqs.filter((_, position) => position !== index))}
                        disabled={readOnly}
                        aria-label="Remove FAQ"
                        className="p-2 text-taupe hover:text-burgundy"
                      >
                        <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                      </button>
                    </div>
                    <textarea
                      rows={2}
                      value={faq.answer}
                      onChange={(event) =>
                        setFaqs(
                          faqs.map((entry, position) =>
                            position === index ? { ...entry, answer: event.target.value } : entry,
                          ),
                        )
                      }
                      className="input h-auto py-2"
                      placeholder="Answer"
                      disabled={readOnly}
                      aria-label="Answer"
                    />
                  </div>
                ))}
              </div>
            </Card>
          </div>

          <div className="space-y-6">
            <Card title="Pricing">
              <div className="space-y-4 p-5">
                <Field label="Price (₹)" htmlFor="price" required>
                  <input
                    id="price"
                    type="number"
                    min="0"
                    value={form.price}
                    onChange={(event) => setForm({ ...form, price: event.target.value })}
                    className="input"
                    disabled={readOnly}
                  />
                </Field>

                <Field
                  label="Compare-at price (₹)"
                  htmlFor="compare"
                  hint="Shown struck through. Must be higher than the price to display a discount."
                >
                  <input
                    id="compare"
                    type="number"
                    min="0"
                    value={form.compareAtPrice}
                    onChange={(event) => setForm({ ...form, compareAtPrice: event.target.value })}
                    className="input"
                    disabled={readOnly}
                  />
                </Field>

                <Field label="Cost price (₹)" htmlFor="cost" hint="Internal only. Never shown to customers.">
                  <input
                    id="cost"
                    type="number"
                    min="0"
                    value={form.costPrice}
                    onChange={(event) => setForm({ ...form, costPrice: event.target.value })}
                    className="input"
                    disabled={readOnly}
                  />
                </Field>

                {form.price && form.compareAtPrice && Number(form.compareAtPrice) > Number(form.price) && (
                  <p className="text-xs text-gold">
                    {Math.round(
                      ((Number(form.compareAtPrice) - Number(form.price)) /
                        Number(form.compareAtPrice)) *
                        100,
                    )}
                    % off — saving {formatPrice(Number(form.compareAtPrice) - Number(form.price))}
                  </p>
                )}
              </div>
            </Card>

            <Card title="Status">
              <div className="space-y-4 p-5">
                <Field label="Status" htmlFor="status">
                  <select
                    id="status"
                    value={form.status}
                    onChange={(event) => setForm({ ...form, status: event.target.value })}
                    className="input"
                    disabled={readOnly}
                  >
                    <option value="DRAFT">Draft — not on the website</option>
                    <option value="PUBLISHED">Published — live</option>
                    <option value="ARCHIVED">Archived — hidden, history kept</option>
                  </select>
                </Field>

                <Field
                  label="Popularity (0–100)"
                  htmlFor="popularity"
                  hint="Drives the Best Selling sort."
                >
                  <input
                    id="popularity"
                    type="number"
                    min={0}
                    max={100}
                    value={form.popularity}
                    onChange={(event) =>
                      setForm({ ...form, popularity: Number(event.target.value) })
                    }
                    className="input"
                    disabled={readOnly}
                  />
                </Field>

                <Field label="Low-stock threshold" htmlFor="threshold">
                  <input
                    id="threshold"
                    type="number"
                    min={0}
                    value={form.lowStockThreshold}
                    onChange={(event) =>
                      setForm({ ...form, lowStockThreshold: Number(event.target.value) })
                    }
                    className="input"
                    disabled={readOnly}
                  />
                </Field>

                <div className="space-y-3 border-t border-line pt-4">
                  <Toggle
                    checked={form.isTrending}
                    onChange={(next) => setForm({ ...form, isTrending: next })}
                    label="Trending"
                    disabled={readOnly}
                  />
                  <Toggle
                    checked={form.isFeatured}
                    onChange={(next) => setForm({ ...form, isFeatured: next })}
                    label="Featured"
                    disabled={readOnly}
                  />
                  <Toggle
                    checked={form.isNewArrival}
                    onChange={(next) => setForm({ ...form, isNewArrival: next })}
                    label="New arrival"
                    disabled={readOnly}
                  />
                </div>
              </div>
            </Card>
          </div>
        </div>
      )}

      {/* ---------------- Media ---------------- */}
      {tab === 'media' && (
        <Card
          title="Images"
          actions={
            !readOnly && (
              <div className="flex gap-2">
                {can('media.upload') && (
                  <label className={cn('btn-primary btn-sm cursor-pointer', uploading && 'opacity-60')}>
                    {uploading ? <Spinner /> : <Upload className="h-3 w-3" strokeWidth={2} />}
                    Upload
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/avif,image/gif"
                      multiple
                      className="sr-only"
                      disabled={uploading}
                      onChange={(event) => {
                        const files = Array.from(event.target.files ?? [])
                        event.target.value = ''
                        if (files.length) void uploadImages(files)
                      }}
                    />
                  </label>
                )}
                <button
                  type="button"
                  onClick={() =>
                    setImages([
                      ...images,
                      { url: '', alt: '', width: 800, height: 1000, isPrimary: images.length === 0 },
                    ])
                  }
                  className="btn-outline btn-sm"
                >
                  <Plus className="h-3 w-3" strokeWidth={2} />
                  Add by URL
                </button>
              </div>
            )
          }
        >
          <div className="space-y-3 p-5">
            {images.length === 0 && (
              <p className="py-8 text-center text-sm text-taupe">
                No images. The first image is used on product cards and as the social sharing
                image.
              </p>
            )}

            {images.map((image, index) => (
              <div key={index} className="flex gap-3 border border-line bg-cream/20 p-3">
                <div className="h-24 w-20 shrink-0 overflow-hidden bg-ivory-deep">
                  {image.url && (
                    <img src={api.absolute(image.url)} alt={image.alt} className="h-full w-full object-cover" />
                  )}
                </div>

                <div className="min-w-0 flex-1 space-y-2">
                  <input
                    value={image.url}
                    onChange={(event) =>
                      setImages(
                        images.map((entry, position) =>
                          position === index ? { ...entry, url: api.mediaPath(event.target.value) } : entry,
                        ),
                      )
                    }
                    className="input"
                    placeholder="Upload, or paste a Media Library or https:// image URL"
                    disabled={readOnly}
                    aria-label="Image URL"
                  />
                  <input
                    value={image.alt}
                    onChange={(event) =>
                      setImages(
                        images.map((entry, position) =>
                          position === index ? { ...entry, alt: event.target.value } : entry,
                        ),
                      )
                    }
                    className="input"
                    placeholder="Descriptive alt text — never a filename"
                    disabled={readOnly}
                    aria-label="Alt text"
                  />
                  <label className="flex items-center gap-2 text-xs text-mocha">
                    <input
                      type="radio"
                      name="primary-image"
                      checked={image.isPrimary}
                      onChange={() =>
                        setImages(
                          images.map((entry, position) => ({
                            ...entry,
                            isPrimary: position === index,
                          })),
                        )
                      }
                      disabled={readOnly}
                    />
                    Primary image
                  </label>
                </div>

                <button
                  type="button"
                  onClick={() => setImages(images.filter((_, position) => position !== index))}
                  disabled={readOnly}
                  aria-label="Remove image"
                  className="h-8 p-2 text-taupe hover:text-burgundy"
                >
                  <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                </button>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ---------------- Variants ---------------- */}
      {tab === 'variants' && (
        <Card
          title="Variants & stock"
          actions={
            !readOnly && (
              <button type="button" onClick={generateVariants} className="btn-outline btn-sm">
                Generate from colours × sizes
              </button>
            )
          }
        >
          <div className="p-5">
            {variants.length === 0 ? (
              <p className="py-8 text-center text-sm text-taupe">
                No variants yet. Choose colours and sizes on the Organisation tab, then generate
                them here.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[44rem]">
                  <thead>
                    <tr>
                      <th className="th">SKU</th>
                      <th className="th">Colour</th>
                      <th className="th">Size</th>
                      <th className="th text-right">Price</th>
                      <th className="th text-right">Stock</th>
                      <th className="th text-center">Active</th>
                      <th className="th w-12" />
                    </tr>
                  </thead>
                  <tbody>
                    {variants.map((variant, index) => (
                      <tr key={variant.id ?? index}>
                        <td className="td">
                          <input
                            value={variant.sku}
                            onChange={(event) =>
                              setVariants(
                                variants.map((entry, position) =>
                                  position === index
                                    ? { ...entry, sku: event.target.value }
                                    : entry,
                                ),
                              )
                            }
                            className="input h-8 font-mono text-xs"
                            disabled={readOnly}
                            aria-label="SKU"
                          />
                        </td>
                        <td className="td text-xs text-mocha">
                          {taxonomy.data?.colors.find((colour) => colour.id === variant.colorId)
                            ?.name ?? '—'}
                        </td>
                        <td className="td text-xs text-mocha">
                          {taxonomy.data?.sizes.find((size) => size.id === variant.sizeId)?.name ??
                            '—'}
                        </td>
                        <td className="td">
                          <input
                            type="number"
                            min="0"
                            value={variant.price}
                            onChange={(event) =>
                              setVariants(
                                variants.map((entry, position) =>
                                  position === index
                                    ? { ...entry, price: Number(event.target.value) }
                                    : entry,
                                ),
                              )
                            }
                            className="input h-8 text-right"
                            disabled={readOnly}
                            aria-label="Price"
                          />
                        </td>
                        <td className="td">
                          <input
                            type="number"
                            min="0"
                            value={variant.inventory}
                            onChange={(event) =>
                              setVariants(
                                variants.map((entry, position) =>
                                  position === index
                                    ? { ...entry, inventory: Number(event.target.value) }
                                    : entry,
                                ),
                              )
                            }
                            className={cn(
                              'input h-8 text-right',
                              variant.inventory === 0 && 'border-burgundy/40',
                            )}
                            disabled={readOnly}
                            aria-label="Stock"
                          />
                        </td>
                        <td className="td text-center">
                          <input
                            type="checkbox"
                            checked={variant.isActive}
                            onChange={(event) =>
                              setVariants(
                                variants.map((entry, position) =>
                                  position === index
                                    ? { ...entry, isActive: event.target.checked }
                                    : entry,
                                ),
                              )
                            }
                            disabled={readOnly}
                            aria-label="Active"
                          />
                        </td>
                        <td className="td">
                          <button
                            type="button"
                            onClick={() =>
                              setVariants(variants.filter((_, position) => position !== index))
                            }
                            disabled={readOnly}
                            aria-label="Remove variant"
                            className="p-1.5 text-taupe hover:text-burgundy"
                          >
                            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <p className="mt-4 text-xs text-taupe">
                  Total stock across all variants: <strong>{totalStock}</strong>. A SKU must be
                  unique across the whole catalogue.
                </p>
              </div>
            )}
          </div>
        </Card>
      )}

      {/* ---------------- Organisation ---------------- */}
      {tab === 'organisation' && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="Classification">
            <div className="space-y-4 p-5">
              <Field label="Category" htmlFor="category" required>
                <select
                  id="category"
                  value={form.categoryId}
                  onChange={(event) => setForm({ ...form, categoryId: event.target.value })}
                  className="input"
                  disabled={readOnly}
                >
                  <option value="">Choose…</option>
                  {taxonomy.data?.categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Material" htmlFor="material" required>
                <select
                  id="material"
                  value={form.materialId}
                  onChange={(event) => setForm({ ...form, materialId: event.target.value })}
                  className="input"
                  disabled={readOnly}
                >
                  <option value="">Choose…</option>
                  {taxonomy.data?.materials.map((material) => (
                    <option key={material.id} value={material.id}>
                      {material.name}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Pattern" htmlFor="pattern" required>
                <select
                  id="pattern"
                  value={form.patternId}
                  onChange={(event) => setForm({ ...form, patternId: event.target.value })}
                  className="input"
                  disabled={readOnly}
                >
                  <option value="">Choose…</option>
                  {taxonomy.data?.patterns.map((pattern) => (
                    <option key={pattern.id} value={pattern.id}>
                      {pattern.name}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Gender" htmlFor="gender">
                <select
                  id="gender"
                  value={form.gender}
                  onChange={(event) => setForm({ ...form, gender: event.target.value })}
                  className="input"
                  disabled={readOnly}
                >
                  <option value="WOMEN">Women</option>
                  <option value="MEN">Men</option>
                  <option value="UNISEX">Unisex</option>
                </select>
              </Field>

              <Field label="Badges">
                <div className="flex flex-wrap gap-1.5">
                  {BADGES.map((badge) => (
                    <button
                      key={badge}
                      type="button"
                      disabled={readOnly}
                      onClick={() =>
                        setBadges(
                          badges.includes(badge)
                            ? badges.filter((entry) => entry !== badge)
                            : [...badges, badge],
                        )
                      }
                      className={cn(
                        'chip transition-colors',
                        badges.includes(badge)
                          ? 'border-charcoal bg-charcoal text-ivory'
                          : 'border-line-strong text-mocha hover:border-charcoal',
                      )}
                    >
                      {badge}
                    </button>
                  ))}
                </div>
              </Field>
            </div>
          </Card>

          <Card title="Options & collections">
            <div className="space-y-5 p-5">
              <Field label="Colours" hint="Which swatches this product is available in.">
                <div className="grid max-h-44 gap-1.5 overflow-y-auto border border-line-strong p-3 sm:grid-cols-2">
                  {taxonomy.data?.colors.map((colour) => (
                    <label key={colour.id} className="flex cursor-pointer items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={colorIds.includes(colour.id)}
                        disabled={readOnly}
                        onChange={(event) =>
                          setColorIds(
                            event.target.checked
                              ? [...colorIds, colour.id]
                              : colorIds.filter((entry) => entry !== colour.id),
                          )
                        }
                        className="h-3.5 w-3.5"
                      />
                      <span
                        className="h-3.5 w-3.5 shrink-0 rounded-full border border-black/10"
                        style={{ backgroundColor: colour.hex }}
                        aria-hidden
                      />
                      <span className="truncate text-mocha">{colour.name}</span>
                    </label>
                  ))}
                </div>
              </Field>

              <Field label="Sizes">
                <div className="grid max-h-40 gap-1.5 overflow-y-auto border border-line-strong p-3">
                  {taxonomy.data?.sizes.map((size) => (
                    <label key={size.id} className="flex cursor-pointer items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={sizeIds.includes(size.id)}
                        disabled={readOnly}
                        onChange={(event) =>
                          setSizeIds(
                            event.target.checked
                              ? [...sizeIds, size.id]
                              : sizeIds.filter((entry) => entry !== size.id),
                          )
                        }
                        className="h-3.5 w-3.5"
                      />
                      <span className="truncate text-mocha">{size.name}</span>
                    </label>
                  ))}
                </div>
              </Field>

              <Field label="Collections" hint="Which edits this product appears in.">
                <div className="grid max-h-44 gap-1.5 overflow-y-auto border border-line-strong p-3 sm:grid-cols-2">
                  {taxonomy.data?.collections.map((collection) => (
                    <label
                      key={collection.id}
                      className="flex cursor-pointer items-center gap-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={collectionIds.includes(collection.id)}
                        disabled={readOnly}
                        onChange={(event) =>
                          setCollectionIds(
                            event.target.checked
                              ? [...collectionIds, collection.id]
                              : collectionIds.filter((entry) => entry !== collection.id),
                          )
                        }
                        className="h-3.5 w-3.5"
                      />
                      <span className="truncate text-mocha">{collection.name}</span>
                    </label>
                  ))}
                </div>
              </Field>
            </div>
          </Card>
        </div>
      )}
    </>
  )
}
