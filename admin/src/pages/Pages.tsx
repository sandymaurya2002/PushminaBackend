import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileText, Pencil } from 'lucide-react'
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
  useToast,
} from '@/components/ui'
import { useAuth } from '@/lib/auth'
import { formatDate } from '@/lib/utils'

/**
 * Website pages — About, Craftsmanship, Contact, Shipping, Returns, Privacy,
 * Terms and FAQs.
 *
 * Body content is a list of sections rather than raw HTML, which keeps the
 * markup semantic and means an editor cannot accidentally paste a script tag
 * into a live page.
 */

interface PageSection {
  heading: string
  body: string[]
  list?: string[]
}

interface PageRow {
  id: string
  slug: string
  title: string
  eyebrow: string | null
  intro: string | null
  sections: PageSection[]
  updatedLabel: string | null
  status: string
  isSystem: boolean
  updatedAt: string
}

export function Pages() {
  const { can } = useAuth()
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const [editing, setEditing] = useState<PageRow | null>(null)
  const [form, setForm] = useState({ title: '', eyebrow: '', intro: '', sections: '', status: 'PUBLISHED' })

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin-pages'],
    queryFn: async () => (await api.get<PageRow[]>('/admin/content/pages')).data,
  })

  function openEdit(page: PageRow) {
    setForm({
      title: page.title,
      eyebrow: page.eyebrow ?? '',
      intro: page.intro ?? '',
      // Sections are edited as readable text: "Heading" then paragraphs,
      // separated by a blank line. Far less error-prone than raw JSON.
      sections: (page.sections ?? [])
        .map((section) => `## ${section.heading}\n${(section.body ?? []).join('\n\n')}`)
        .join('\n\n'),
      status: page.status,
    })
    setEditing(page)
  }

  const save = useMutation({
    mutationFn: async () => {
      if (!editing) return
      const blocks = form.sections.split(/\n(?=## )/).filter((block) => block.trim())
      const sections = blocks.map((block) => {
        const lines = block.split('\n')
        const heading = lines[0].replace(/^##\s*/, '').trim()
        const body = lines
          .slice(1)
          .join('\n')
          .split('\n\n')
          .map((paragraph) => paragraph.trim())
          .filter(Boolean)
        return { heading, body }
      })

      return api.put(`/admin/content/pages/${editing.id}`, {
        title: form.title,
        eyebrow: form.eyebrow || null,
        intro: form.intro || null,
        sections,
        faqs: [],
        status: form.status,
      })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-pages'] })
      setEditing(null)
      toast({ title: 'Page saved', description: 'The website has been updated.' })
    },
    onError: (caught) =>
      toast({
        title: 'Could not save',
        description: caught instanceof ApiError ? caught.message : 'Unexpected error.',
        tone: 'error',
      }),
  })

  return (
    <>
      <PageHeader
        title="Pages"
        description="Editorial and policy pages. Content is editable here without touching the website code."
      />

      <Card>
        {isLoading ? (
          <LoadingBlock rows={6} />
        ) : error ? (
          <ErrorState error={error} retry={() => void refetch()} />
        ) : !data?.length ? (
          <EmptyState icon={<FileText className="h-6 w-6" strokeWidth={1} />} title="No pages" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem]">
              <thead>
                <tr>
                  <th className="th">Page</th>
                  <th className="th">URL</th>
                  <th className="th">Sections</th>
                  <th className="th">Updated</th>
                  <th className="th">Status</th>
                  <th className="th w-16 text-right">Edit</th>
                </tr>
              </thead>
              <tbody>
                {data.map((page) => (
                  <tr key={page.id} className="transition-colors hover:bg-cream/40">
                    <td className="td text-charcoal">
                      {page.title}
                      {page.isSystem && (
                        <span className="ml-2 text-[0.625rem] uppercase tracking-[0.1em] text-taupe">
                          system
                        </span>
                      )}
                    </td>
                    <td className="td">
                      <code className="text-[0.6875rem] text-mocha">/{page.slug}</code>
                    </td>
                    <td className="td text-mocha">{page.sections?.length ?? 0}</td>
                    <td className="td text-xs text-taupe">{formatDate(page.updatedAt)}</td>
                    <td className="td">
                      <Badge
                        className={
                          page.status === 'PUBLISHED'
                            ? 'border-success/40 text-success'
                            : 'border-line-strong text-taupe'
                        }
                      >
                        {page.status}
                      </Badge>
                    </td>
                    <td className="td text-right">
                      {can('content.update') && (
                        <button
                          type="button"
                          onClick={() => openEdit(page)}
                          aria-label={`Edit ${page.title}`}
                          className="p-1.5 text-taupe transition-colors hover:text-charcoal"
                        >
                          <Pencil className="h-3.5 w-3.5" strokeWidth={1.5} />
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

      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        wide
        title={`Edit ${editing?.title ?? ''}`}
        footer={
          <>
            <button type="button" onClick={() => setEditing(null)} className="btn-ghost">
              Cancel
            </button>
            <button
              type="button"
              onClick={() => save.mutate()}
              disabled={save.isPending || !form.title}
              className="btn-primary"
            >
              {save.isPending && <Spinner />}
              Save changes
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Title" htmlFor="p-title" required>
              <input
                id="p-title"
                value={form.title}
                onChange={(event) => setForm({ ...form, title: event.target.value })}
                className="input"
              />
            </Field>

            <Field label="Status" htmlFor="p-status">
              <select
                id="p-status"
                value={form.status}
                onChange={(event) => setForm({ ...form, status: event.target.value })}
                className="input"
              >
                <option value="PUBLISHED">Published</option>
                <option value="DRAFT">Draft</option>
              </select>
            </Field>
          </div>

          <Field label="Eyebrow" htmlFor="p-eyebrow" hint="Small uppercase line above the title.">
            <input
              id="p-eyebrow"
              value={form.eyebrow}
              onChange={(event) => setForm({ ...form, eyebrow: event.target.value })}
              className="input"
            />
          </Field>

          <Field label="Intro" htmlFor="p-intro">
            <textarea
              id="p-intro"
              rows={3}
              value={form.intro}
              onChange={(event) => setForm({ ...form, intro: event.target.value })}
              className="input h-auto py-2"
            />
          </Field>

          <Field
            label="Sections"
            htmlFor="p-sections"
            hint="Start a section with ## followed by its heading. Separate paragraphs with a blank line."
          >
            <textarea
              id="p-sections"
              rows={16}
              value={form.sections}
              onChange={(event) => setForm({ ...form, sections: event.target.value })}
              className="input h-auto py-2 font-mono text-xs"
              placeholder={'## Dispatch\nIn-stock pieces are dispatched within 48 hours.\n\nYou will receive a tracking number by email.'}
            />
          </Field>
        </div>
      </Modal>
    </>
  )
}
