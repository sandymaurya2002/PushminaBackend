import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Boxes, Pencil, Plus, Trash2 } from 'lucide-react'
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

interface Collection {
  id: string
  slug: string
  name: string
  heading: string | null
  description: string
  seoContent: string[]
  group: string
  bannerUrl: string | null
  bannerAlt: string | null
  isHidden: boolean
  isFeatured: boolean
  sortOrder: number
  _count: { products: number }
}

interface CollectionDetail extends Collection {
  includeCategoryIds: string[]
  relatedCollectionIds: string[]
  productIds: string[]
  faqs: Array<{ question: string; answer: string }>
}

const GROUPS = ['WOMEN', 'MEN', 'COLLECTIONS', 'GIFTING', 'CATEGORY']

export function Collections() {
  const { can } = useAuth()
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const [group, setGroup] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<Collection | null>(null)

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin-collections', group],
    queryFn: async () =>
      (await api.get<Collection[]>('/admin/content/collections', { group: group || undefined, limit: 200 }))
        .data,
  })

  const { data: detail } = useQuery({
    queryKey: ['admin-collection', editingId],
    queryFn: async () =>
      (await api.get<CollectionDetail>(`/admin/content/collections/${editingId}`)).data,
    enabled: Boolean(editingId),
  })

  const { data: categories } = useQuery({
    queryKey: ['admin-categories-list'],
    queryFn: async () =>
      (await api.get<Array<{ id: string; name: string }>>('/admin/taxonomy/categories')).data,
  })

  const remove = useMutation({
    mutationFn: async (id: string) => api.delete(`/admin/content/collections/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-collections'] })
      setDeleting(null)
      toast({ title: 'Collection deleted' })
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

  return (
    <>
      <PageHeader
        title="Collections"
        description="The edits customers browse. An aggregate collection can also pull in every product from chosen categories."
        actions={
          can('collections.create') && (
            <button type="button" onClick={() => setCreating(true)} className="btn-primary">
              <Plus className="h-3.5 w-3.5" strokeWidth={2} />
              New collection
            </button>
          )
        }
      />

      <div className="mb-4 flex flex-wrap gap-1">
        <button
          type="button"
          onClick={() => setGroup('')}
          className={`chip transition-colors ${
            !group
              ? 'border-charcoal bg-charcoal text-ivory'
              : 'border-line-strong text-mocha hover:border-charcoal'
          }`}
        >
          All
        </button>
        {GROUPS.map((entry) => (
          <button
            key={entry}
            type="button"
            onClick={() => setGroup(entry)}
            className={`chip transition-colors ${
              group === entry
                ? 'border-charcoal bg-charcoal text-ivory'
                : 'border-line-strong text-mocha hover:border-charcoal'
            }`}
          >
            {entry}
          </button>
        ))}
      </div>

      <Card>
        {isLoading ? (
          <LoadingBlock rows={8} />
        ) : error ? (
          <ErrorState error={error} retry={() => void refetch()} />
        ) : !data?.length ? (
          <EmptyState
            icon={<Boxes className="h-6 w-6" strokeWidth={1} />}
            title="No collections"
            description="Create one to group products on the website."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem]">
              <thead>
                <tr>
                  <th className="th">Collection</th>
                  <th className="th">Group</th>
                  <th className="th text-right">Products</th>
                  <th className="th">Visibility</th>
                  <th className="th w-20 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.map((collection) => (
                  <tr key={collection.id} className="transition-colors hover:bg-cream/40">
                    <td className="td">
                      <span className="block text-charcoal">{collection.name}</span>
                      <code className="mt-0.5 block text-[0.6875rem] text-taupe">
                        /collections/{collection.slug}
                      </code>
                    </td>
                    <td className="td text-mocha">{collection.group}</td>
                    <td className="td text-right tabular-nums text-mocha">
                      {collection._count.products}
                    </td>
                    <td className="td">
                      <div className="flex flex-wrap gap-1">
                        <Badge
                          className={
                            collection.isHidden
                              ? 'border-line-strong text-taupe'
                              : 'border-success/40 text-success'
                          }
                        >
                          {collection.isHidden ? 'Hidden' : 'Live'}
                        </Badge>
                        {collection.isFeatured && (
                          <Badge className="border-gold/40 text-gold">Featured</Badge>
                        )}
                      </div>
                    </td>
                    <td className="td">
                      <div className="flex justify-end gap-1">
                        {can('collections.update') && (
                          <button
                            type="button"
                            onClick={() => setEditingId(collection.id)}
                            aria-label={`Edit ${collection.name}`}
                            className="p-1.5 text-taupe transition-colors hover:text-charcoal"
                          >
                            <Pencil className="h-3.5 w-3.5" strokeWidth={1.5} />
                          </button>
                        )}
                        {can('collections.delete') && (
                          <button
                            type="button"
                            onClick={() => setDeleting(collection)}
                            aria-label={`Delete ${collection.name}`}
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

      <CollectionModal
        open={creating || Boolean(editingId)}
        detail={editingId ? (detail ?? null) : null}
        categories={categories ?? []}
        onClose={() => {
          setCreating(false)
          setEditingId(null)
        }}
        onSaved={() => {
          void queryClient.invalidateQueries({ queryKey: ['admin-collections'] })
          setCreating(false)
          setEditingId(null)
        }}
      />

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
        busy={remove.isPending}
        title={`Delete ${deleting?.name}?`}
        message="Products are not deleted, only their membership of this collection. Any landing page pointing at it must be repointed first."
      />
    </>
  )
}

/* ------------------------------------------------------------------ */

function CollectionModal({
  open,
  detail,
  categories,
  onClose,
  onSaved,
}: {
  open: boolean
  detail: CollectionDetail | null
  categories: Array<{ id: string; name: string }>
  onClose: () => void
  onSaved: () => void
}) {
  const { toast } = useToast()
  const [form, setForm] = useState({
    name: '',
    slug: '',
    heading: '',
    description: '',
    seoContent: '',
    group: 'COLLECTIONS',
    bannerUrl: '',
    bannerAlt: '',
    isHidden: false,
    isFeatured: false,
    sortOrder: 0,
    includeCategoryIds: [] as string[],
  })
  const [seeded, setSeeded] = useState<string | null>(null)

  // Seed once per record, so typing is never overwritten by a background refetch.
  const seedKey = detail?.id ?? (open ? 'new' : null)
  if (open && seedKey && seeded !== seedKey) {
    setForm({
      name: detail?.name ?? '',
      slug: detail?.slug ?? '',
      heading: detail?.heading ?? '',
      description: detail?.description ?? '',
      seoContent: (detail?.seoContent ?? []).join('\n\n'),
      group: detail?.group ?? 'COLLECTIONS',
      bannerUrl: detail?.bannerUrl ?? '',
      bannerAlt: detail?.bannerAlt ?? '',
      isHidden: detail?.isHidden ?? false,
      isFeatured: detail?.isFeatured ?? false,
      sortOrder: detail?.sortOrder ?? 0,
      includeCategoryIds: detail?.includeCategoryIds ?? [],
    })
    setSeeded(seedKey)
  }
  if (!open && seeded) setSeeded(null)

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name: form.name,
        slug: form.slug || undefined,
        heading: form.heading || null,
        description: form.description,
        seoContent: form.seoContent.split('\n\n').map((p) => p.trim()).filter(Boolean),
        group: form.group,
        bannerUrl: form.bannerUrl || null,
        bannerAlt: form.bannerAlt || null,
        isHidden: form.isHidden,
        isFeatured: form.isFeatured,
        sortOrder: Number(form.sortOrder),
        includeCategoryIds: form.includeCategoryIds,
        relatedCollectionIds: detail?.relatedCollectionIds ?? [],
        productIds: detail?.productIds ?? [],
        faqs: detail?.faqs ?? [],
      }
      return detail
        ? api.put(`/admin/content/collections/${detail.id}`, body)
        : api.post('/admin/content/collections', body)
    },
    onSuccess: () => {
      toast({ title: detail ? 'Collection saved' : 'Collection created' })
      onSaved()
    },
    onError: (caught) =>
      toast({
        title: 'Could not save',
        description: caught instanceof ApiError ? caught.message : 'Unexpected error.',
        tone: 'error',
      }),
  })

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={detail ? `Edit ${detail.name}` : 'New collection'}
      footer={
        <>
          <button type="button" onClick={onClose} className="btn-ghost">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => save.mutate()}
            disabled={save.isPending || !form.name || !form.description}
            className="btn-primary"
          >
            {save.isPending && <Spinner />}
            {detail ? 'Save changes' : 'Create'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="col-name" required>
            <input
              id="col-name"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              className="input"
            />
          </Field>

          <Field label="Group" htmlFor="col-group" required>
            <select
              id="col-group"
              value={form.group}
              onChange={(event) => setForm({ ...form, group: event.target.value })}
              className="input"
            >
              {GROUPS.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="URL slug" htmlFor="col-slug" hint="Generated from the name if left blank.">
          <input
            id="col-slug"
            value={form.slug}
            onChange={(event) => setForm({ ...form, slug: event.target.value })}
            className="input"
            placeholder="auto-generated"
          />
        </Field>

        <Field label="Page heading" htmlFor="col-heading" hint="Falls back to the name.">
          <input
            id="col-heading"
            value={form.heading}
            onChange={(event) => setForm({ ...form, heading: event.target.value })}
            className="input"
          />
        </Field>

        <Field
          label="Description"
          htmlFor="col-desc"
          required
          hint="Shown under the heading and used as the meta description."
        >
          <textarea
            id="col-desc"
            rows={3}
            value={form.description}
            onChange={(event) => setForm({ ...form, description: event.target.value })}
            className="input h-auto py-2"
          />
        </Field>

        <Field
          label="Long-form copy"
          htmlFor="col-seo"
          hint="Rendered below the product grid. Separate paragraphs with a blank line."
        >
          <textarea
            id="col-seo"
            rows={6}
            value={form.seoContent}
            onChange={(event) => setForm({ ...form, seoContent: event.target.value })}
            className="input h-auto py-2"
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Banner image URL" htmlFor="col-banner">
            <input
              id="col-banner"
              value={form.bannerUrl}
              onChange={(event) => setForm({ ...form, bannerUrl: event.target.value })}
              className="input"
              placeholder="/images/banners/…"
            />
          </Field>

          <Field label="Banner alt text" htmlFor="col-alt">
            <input
              id="col-alt"
              value={form.bannerAlt}
              onChange={(event) => setForm({ ...form, bannerAlt: event.target.value })}
              className="input"
            />
          </Field>
        </div>

        <Field
          label="Also include every product in these categories"
          hint="Use this for aggregate collections such as “Shawls”, which span both genders."
        >
          <div className="grid max-h-40 gap-1.5 overflow-y-auto border border-line-strong p-3 sm:grid-cols-2">
            {categories.map((category) => (
              <label key={category.id} className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.includeCategoryIds.includes(category.id)}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      includeCategoryIds: event.target.checked
                        ? [...form.includeCategoryIds, category.id]
                        : form.includeCategoryIds.filter((id) => id !== category.id),
                    })
                  }
                  className="h-3.5 w-3.5"
                />
                <span className="text-mocha">{category.name}</span>
              </label>
            ))}
          </div>
        </Field>

        <div className="flex flex-wrap gap-6">
          <Toggle
            checked={!form.isHidden}
            onChange={(next) => setForm({ ...form, isHidden: !next })}
            label="Visible on the website"
          />
          <Toggle
            checked={form.isFeatured}
            onChange={(next) => setForm({ ...form, isFeatured: next })}
            label="Featured"
            description="Given priority in the collections index and sitemap."
          />
        </div>
      </div>
    </Modal>
  )
}
