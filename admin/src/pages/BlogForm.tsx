import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, ChevronLeft, Plus, Trash2 } from 'lucide-react'
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
import { toSlug } from '@/lib/utils'

/**
 * Article editor.
 *
 * The body is a list of typed blocks rather than a rich-text field. That keeps
 * the published markup semantic, keeps the heading hierarchy from skipping a
 * level, and means an editor cannot paste markup that breaks the page — the
 * same structure the storefront's BlockRenderer already expects.
 */

type Block =
  | { type: 'paragraph'; text: string }
  | { type: 'heading'; text: string }
  | { type: 'subheading'; text: string }
  | { type: 'list'; items: string[] }
  | { type: 'quote'; text: string; attribution?: string }
  | { type: 'productLink'; slug: string; label: string }
  | { type: 'collectionLink'; slug: string; label: string }
  | { type: 'image'; url: string; alt: string; caption?: string }

const BLOCK_TYPES: Array<{ type: Block['type']; label: string }> = [
  { type: 'paragraph', label: 'Paragraph' },
  { type: 'heading', label: 'Heading' },
  { type: 'subheading', label: 'Subheading' },
  { type: 'list', label: 'List' },
  { type: 'quote', label: 'Quote' },
  { type: 'image', label: 'Image' },
  { type: 'productLink', label: 'Product link' },
  { type: 'collectionLink', label: 'Collection link' },
]

function emptyBlock(type: Block['type']): Block {
  switch (type) {
    case 'list':
      return { type: 'list', items: [''] }
    case 'quote':
      return { type: 'quote', text: '', attribution: '' }
    case 'image':
      return { type: 'image', url: '', alt: '' }
    case 'productLink':
      return { type: 'productLink', slug: '', label: '' }
    case 'collectionLink':
      return { type: 'collectionLink', slug: '', label: '' }
    default:
      return { type, text: '' } as Block
  }
}

export function BlogForm() {
  const { id } = useParams<{ id: string }>()
  const isNew = !id || id === 'new'
  const navigate = useNavigate()
  const { can } = useAuth()
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const [form, setForm] = useState({
    title: '',
    slug: '',
    excerpt: '',
    categoryId: '',
    authorName: 'Pushmina Editorial',
    coverUrl: '',
    coverAlt: '',
    readingMinutes: 5,
    status: 'DRAFT',
    scheduledAt: '',
  })
  const [blocks, setBlocks] = useState<Block[]>([{ type: 'paragraph', text: '' }])
  const [seeded, setSeeded] = useState(false)

  const categories = useQuery({
    queryKey: ['blog-categories'],
    queryFn: async () =>
      (await api.get<Array<{ id: string; name: string }>>('/admin/blog/categories')).data,
  })

  const post = useQuery({
    queryKey: ['admin-post', id],
    queryFn: async () => (await api.get<Record<string, unknown>>(`/admin/blog/posts/${id}`)).data,
    enabled: !isNew,
  })

  if (!isNew && post.data && !seeded) {
    const data = post.data as Record<string, never>
    setForm({
      title: String(data.title ?? ''),
      slug: String(data.slug ?? ''),
      excerpt: String(data.excerpt ?? ''),
      categoryId: String(data.categoryId ?? ''),
      authorName: String(data.authorName ?? 'Pushmina Editorial'),
      coverUrl: String(data.coverUrl ?? ''),
      coverAlt: String(data.coverAlt ?? ''),
      readingMinutes: Number(data.readingMinutes ?? 5),
      status: String(data.status ?? 'DRAFT'),
      scheduledAt: data.scheduledAt ? String(data.scheduledAt).slice(0, 16) : '',
    })
    setBlocks((data.blocks as unknown as Block[]) ?? [])
    setSeeded(true)
  }

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        title: form.title,
        slug: form.slug || undefined,
        excerpt: form.excerpt,
        categoryId: form.categoryId,
        authorName: form.authorName,
        coverUrl: form.coverUrl || null,
        coverAlt: form.coverAlt || null,
        blocks,
        readingMinutes: Number(form.readingMinutes),
        status: form.status,
        scheduledAt: form.status === 'SCHEDULED' && form.scheduledAt ? form.scheduledAt : null,
        tagIds: [],
        relatedProductIds: [],
        relatedCollectionIds: [],
        faqs: [],
      }
      return isNew
        ? api.post<{ id: string }>('/admin/blog/posts', body)
        : api.put<{ id: string }>(`/admin/blog/posts/${id}`, body)
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['admin-posts'] })
      toast({ title: isNew ? 'Article created' : 'Article saved' })
      if (isNew) navigate(`/blog/${result.data.id}`, { replace: true })
    },
    onError: (caught) =>
      toast({
        title: 'Could not save',
        description: caught instanceof ApiError ? caught.message : 'Unexpected error.',
        tone: 'error',
      }),
  })

  function updateBlock(index: number, next: Block) {
    setBlocks(blocks.map((block, position) => (position === index ? next : block)))
  }

  function moveBlock(index: number, direction: -1 | 1) {
    const target = index + direction
    if (target < 0 || target >= blocks.length) return
    const next = [...blocks]
    ;[next[index], next[target]] = [next[target], next[index]]
    setBlocks(next)
  }

  if (!isNew && post.isLoading) return <LoadingBlock rows={10} />
  if (!isNew && post.error) return <ErrorState error={post.error} />

  const readOnly = !can(isNew ? 'blog.create' : 'blog.update')

  return (
    <>
      <Link
        to="/blog"
        className="mb-5 inline-flex items-center gap-1.5 text-[0.6875rem] uppercase tracking-[0.12em] text-taupe transition-colors hover:text-charcoal"
      >
        <ChevronLeft className="h-3.5 w-3.5" strokeWidth={1.5} />
        All articles
      </Link>

      <PageHeader
        title={isNew ? 'New article' : form.title || 'Edit article'}
        actions={
          !readOnly && (
            <button
              type="button"
              onClick={() => save.mutate()}
              disabled={save.isPending || !form.title || !form.excerpt || !form.categoryId}
              className="btn-primary"
            >
              {save.isPending && <Spinner />}
              {isNew ? 'Create article' : 'Save changes'}
            </button>
          )
        }
      />

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card title="Article">
            <div className="space-y-4 p-5">
              <Field label="Title" htmlFor="title" required>
                <input
                  id="title"
                  value={form.title}
                  onChange={(event) => {
                    const title = event.target.value
                    setForm((current) => ({
                      ...current,
                      title,
                      // Only auto-fill the slug while creating, so editing a
                      // live article never silently changes its URL.
                      slug: isNew && !current.slug ? toSlug(title) : current.slug,
                    }))
                  }}
                  className="input"
                  disabled={readOnly}
                />
              </Field>

              <Field
                label="URL slug"
                htmlFor="slug"
                hint="Changing this on a published article breaks existing links. Add a redirect if you do."
              >
                <input
                  id="slug"
                  value={form.slug}
                  onChange={(event) => setForm({ ...form, slug: event.target.value })}
                  className="input font-mono text-xs"
                  disabled={readOnly}
                />
              </Field>

              <Field
                label="Excerpt"
                htmlFor="excerpt"
                required
                hint="Shown on cards and used as the meta description."
              >
                <textarea
                  id="excerpt"
                  rows={3}
                  value={form.excerpt}
                  onChange={(event) => setForm({ ...form, excerpt: event.target.value })}
                  className="input h-auto py-2"
                  disabled={readOnly}
                />
              </Field>
            </div>
          </Card>

          <Card
            title="Body"
            actions={
              !readOnly && (
                <select
                  value=""
                  onChange={(event) => {
                    if (!event.target.value) return
                    setBlocks([...blocks, emptyBlock(event.target.value as Block['type'])])
                    event.target.value = ''
                  }}
                  className="input h-8 w-auto py-0 text-xs"
                  aria-label="Add block"
                >
                  <option value="">+ Add block…</option>
                  {BLOCK_TYPES.map((entry) => (
                    <option key={entry.type} value={entry.type}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              )
            }
          >
            <div className="space-y-3 p-5">
              {blocks.length === 0 && (
                <p className="py-8 text-center text-sm text-taupe">
                  No content yet. Add a block to begin.
                </p>
              )}

              {blocks.map((block, index) => (
                <div key={index} className="border border-line bg-cream/20 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="eyebrow text-taupe">
                      {BLOCK_TYPES.find((entry) => entry.type === block.type)?.label ?? block.type}
                    </span>
                    {!readOnly && (
                      <div className="flex gap-0.5">
                        <button
                          type="button"
                          onClick={() => moveBlock(index, -1)}
                          disabled={index === 0}
                          aria-label="Move up"
                          className="p-1 text-taupe hover:text-charcoal disabled:opacity-30"
                        >
                          <ArrowUp className="h-3 w-3" strokeWidth={1.5} />
                        </button>
                        <button
                          type="button"
                          onClick={() => moveBlock(index, 1)}
                          disabled={index === blocks.length - 1}
                          aria-label="Move down"
                          className="p-1 text-taupe hover:text-charcoal disabled:opacity-30"
                        >
                          <ArrowDown className="h-3 w-3" strokeWidth={1.5} />
                        </button>
                        <button
                          type="button"
                          onClick={() => setBlocks(blocks.filter((_, i) => i !== index))}
                          aria-label="Remove block"
                          className="p-1 text-taupe hover:text-burgundy"
                        >
                          <Trash2 className="h-3 w-3" strokeWidth={1.5} />
                        </button>
                      </div>
                    )}
                  </div>

                  {(block.type === 'paragraph' ||
                    block.type === 'heading' ||
                    block.type === 'subheading') && (
                    <textarea
                      rows={block.type === 'paragraph' ? 4 : 1}
                      value={block.text}
                      onChange={(event) =>
                        updateBlock(index, { ...block, text: event.target.value })
                      }
                      className="input h-auto py-2"
                      disabled={readOnly}
                      aria-label={block.type}
                    />
                  )}

                  {block.type === 'list' && (
                    <div className="space-y-1.5">
                      {block.items.map((item, itemIndex) => (
                        <div key={itemIndex} className="flex gap-2">
                          <input
                            value={item}
                            onChange={(event) =>
                              updateBlock(index, {
                                ...block,
                                items: block.items.map((entry, position) =>
                                  position === itemIndex ? event.target.value : entry,
                                ),
                              })
                            }
                            className="input"
                            disabled={readOnly}
                            aria-label={`List item ${itemIndex + 1}`}
                          />
                          <button
                            type="button"
                            onClick={() =>
                              updateBlock(index, {
                                ...block,
                                items: block.items.filter((_, position) => position !== itemIndex),
                              })
                            }
                            disabled={readOnly}
                            aria-label="Remove item"
                            className="p-2 text-taupe hover:text-burgundy"
                          >
                            <Trash2 className="h-3 w-3" strokeWidth={1.5} />
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() => updateBlock(index, { ...block, items: [...block.items, ''] })}
                        disabled={readOnly}
                        className="btn-outline btn-sm"
                      >
                        <Plus className="h-3 w-3" strokeWidth={2} />
                        Item
                      </button>
                    </div>
                  )}

                  {block.type === 'quote' && (
                    <div className="space-y-2">
                      <textarea
                        rows={2}
                        value={block.text}
                        onChange={(event) =>
                          updateBlock(index, { ...block, text: event.target.value })
                        }
                        className="input h-auto py-2"
                        placeholder="Quote"
                        disabled={readOnly}
                        aria-label="Quote"
                      />
                      <input
                        value={block.attribution ?? ''}
                        onChange={(event) =>
                          updateBlock(index, { ...block, attribution: event.target.value })
                        }
                        className="input"
                        placeholder="Attribution"
                        disabled={readOnly}
                        aria-label="Attribution"
                      />
                    </div>
                  )}

                  {block.type === 'image' && (
                    <div className="space-y-2">
                      <input
                        value={block.url}
                        onChange={(event) =>
                          updateBlock(index, { ...block, url: event.target.value })
                        }
                        className="input"
                        placeholder="Image URL"
                        disabled={readOnly}
                        aria-label="Image URL"
                      />
                      <input
                        value={block.alt}
                        onChange={(event) =>
                          updateBlock(index, { ...block, alt: event.target.value })
                        }
                        className="input"
                        placeholder="Alt text (required for accessibility)"
                        disabled={readOnly}
                        aria-label="Alt text"
                      />
                    </div>
                  )}

                  {(block.type === 'productLink' || block.type === 'collectionLink') && (
                    <div className="grid gap-2 sm:grid-cols-2">
                      <input
                        value={block.slug}
                        onChange={(event) =>
                          updateBlock(index, { ...block, slug: event.target.value })
                        }
                        className="input font-mono text-xs"
                        placeholder="slug"
                        disabled={readOnly}
                        aria-label="Slug"
                      />
                      <input
                        value={block.label}
                        onChange={(event) =>
                          updateBlock(index, { ...block, label: event.target.value })
                        }
                        className="input"
                        placeholder="Link label"
                        disabled={readOnly}
                        aria-label="Label"
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Card>
        </div>

        <div className="space-y-6">
          <Card title="Publishing">
            <div className="space-y-4 p-5">
              <Field label="Status" htmlFor="status">
                <select
                  id="status"
                  value={form.status}
                  onChange={(event) => setForm({ ...form, status: event.target.value })}
                  className="input"
                  disabled={readOnly}
                >
                  <option value="DRAFT">Draft</option>
                  <option value="SCHEDULED">Scheduled</option>
                  <option value="PUBLISHED">Published</option>
                  <option value="ARCHIVED">Archived</option>
                </select>
              </Field>

              {form.status === 'SCHEDULED' && (
                <Field
                  label="Publish at"
                  htmlFor="scheduled"
                  required
                  hint="Must be in the future. The article goes live automatically."
                >
                  <input
                    id="scheduled"
                    type="datetime-local"
                    value={form.scheduledAt}
                    onChange={(event) => setForm({ ...form, scheduledAt: event.target.value })}
                    className="input"
                    disabled={readOnly}
                  />
                </Field>
              )}

              <Field label="Category" htmlFor="category" required>
                <select
                  id="category"
                  value={form.categoryId}
                  onChange={(event) => setForm({ ...form, categoryId: event.target.value })}
                  className="input"
                  disabled={readOnly}
                >
                  <option value="">Choose…</option>
                  {categories.data?.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Author" htmlFor="author">
                <input
                  id="author"
                  value={form.authorName}
                  onChange={(event) => setForm({ ...form, authorName: event.target.value })}
                  className="input"
                  disabled={readOnly}
                />
              </Field>

              <Field label="Reading time (minutes)" htmlFor="reading">
                <input
                  id="reading"
                  type="number"
                  min={1}
                  max={120}
                  value={form.readingMinutes}
                  onChange={(event) =>
                    setForm({ ...form, readingMinutes: Number(event.target.value) })
                  }
                  className="input"
                  disabled={readOnly}
                />
              </Field>
            </div>
          </Card>

          <Card title="Cover image">
            <div className="space-y-4 p-5">
              {form.coverUrl && (
                <div className="aspect-[3/2] overflow-hidden bg-ivory-deep">
                  <img
                    src={form.coverUrl}
                    alt={form.coverAlt}
                    className="h-full w-full object-cover"
                  />
                </div>
              )}

              <Field label="Image URL" htmlFor="cover">
                <input
                  id="cover"
                  value={form.coverUrl}
                  onChange={(event) => setForm({ ...form, coverUrl: event.target.value })}
                  className="input"
                  placeholder="/images/blog/…"
                  disabled={readOnly}
                />
              </Field>

              <Field label="Alt text" htmlFor="coverAlt" hint="Describes the image for screen readers and search engines.">
                <input
                  id="coverAlt"
                  value={form.coverAlt}
                  onChange={(event) => setForm({ ...form, coverAlt: event.target.value })}
                  className="input"
                  disabled={readOnly}
                />
              </Field>
            </div>
          </Card>
        </div>
      </div>
    </>
  )
}
