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

interface PageFaq {
  question: string
  answer: string
}

interface PageRow {
  id: string
  slug: string
  title: string
  eyebrow: string | null
  intro: string | null
  sections: PageSection[]
  faqs: PageFaq[]
  updatedLabel: string | null
  metaTitle: string | null
  metaDescription: string | null
  status: string
  isSystem: boolean
  updatedAt: string
}

const EMPTY_FORM = {
  title: '',
  eyebrow: '',
  intro: '',
  sections: '',
  faqs: '',
  updatedLabel: '',
  metaTitle: '',
  metaDescription: '',
  status: 'PUBLISHED',
}

/**
 * Sections are edited as readable text rather than JSON: "## Heading", then
 * paragraphs separated by a blank line, with "- " lines for a bullet list.
 */
function sectionsToText(sections: PageSection[]): string {
  return sections
    .map((section) =>
      [
        `## ${section.heading}`,
        ...(section.body ?? []).flatMap((paragraph) => [paragraph, '']),
        ...(section.list ?? []).map((item) => `- ${item}`),
      ]
        .join('\n')
        .trim(),
    )
    .join('\n\n')
}

function textToSections(text: string): PageSection[] {
  return text
    .split(/\n(?=## )/)
    .filter((block) => block.trim())
    .map((block) => {
      const [first = '', ...rest] = block.split('\n')
      const list = rest.filter((line) => /^\s*-\s+/.test(line)).map((line) => line.replace(/^\s*-\s+/, '').trim())
      const body = rest
        .filter((line) => !/^\s*-\s+/.test(line))
        .join('\n')
        .split(/\n\s*\n/)
        .map((paragraph) => paragraph.trim())
        .filter(Boolean)
      return { heading: first.replace(/^##\s*/, '').trim(), body, ...(list.length ? { list } : {}) }
    })
}

/** FAQs as "Q: …" / "A: …" pairs separated by a blank line. */
function faqsToText(faqs: PageFaq[]): string {
  return faqs.map((faq) => `Q: ${faq.question}\nA: ${faq.answer}`).join('\n\n')
}

function textToFaqs(text: string): PageFaq[] {
  return text
    .split(/\n\s*\n/)
    .map((block) => {
      const question = /^Q:\s*(.+)$/im.exec(block)?.[1]?.trim() ?? ''
      const answer = /^A:\s*([\s\S]+)$/im.exec(block)?.[1]?.trim() ?? ''
      return { question, answer }
    })
    .filter((faq) => faq.question && faq.answer)
}

export function Pages() {
  const { can } = useAuth()
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const [editing, setEditing] = useState<PageRow | null>(null)
  const [form, setForm] = useState(EMPTY_FORM)

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin-pages'],
    queryFn: async () => (await api.get<PageRow[]>('/admin/content/pages')).data,
  })

  function openEdit(page: PageRow) {
    setForm({
      title: page.title,
      eyebrow: page.eyebrow ?? '',
      intro: page.intro ?? '',
      sections: sectionsToText(page.sections ?? []),
      faqs: faqsToText(page.faqs ?? []),
      updatedLabel: page.updatedLabel ?? '',
      metaTitle: page.metaTitle ?? '',
      metaDescription: page.metaDescription ?? '',
      status: page.status,
    })
    setEditing(page)
  }

  const save = useMutation({
    mutationFn: async () => {
      if (!editing) return
      return api.put(`/admin/content/pages/${editing.id}`, {
        title: form.title,
        eyebrow: form.eyebrow || null,
        intro: form.intro || null,
        sections: textToSections(form.sections),
        faqs: textToFaqs(form.faqs),
        updatedLabel: form.updatedLabel || null,
        metaTitle: form.metaTitle || null,
        metaDescription: form.metaDescription || null,
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
            hint="Start a section with ## followed by its heading. Separate paragraphs with a blank line; start a line with - for a bullet point."
          >
            <textarea
              id="p-sections"
              rows={16}
              value={form.sections}
              onChange={(event) => setForm({ ...form, sections: event.target.value })}
              className="input h-auto py-2 font-mono text-xs"
              placeholder={'## Dispatch\nIn-stock pieces are dispatched within 48 hours.\n\nYou will receive a tracking number by email.\n- Mainland India: 3–6 working days'}
            />
          </Field>

          <Field label="FAQs" htmlFor="p-faqs" hint='Each question as "Q: …" then "A: …" on the next line, separated by a blank line.'>
            <textarea
              id="p-faqs"
              rows={8}
              value={form.faqs}
              onChange={(event) => setForm({ ...form, faqs: event.target.value })}
              className="input h-auto py-2 font-mono text-xs"
              placeholder={'Q: How long does delivery take?\nA: 3–6 working days within India.'}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Last updated label" htmlFor="p-updated" hint='Shown on the page, e.g. "1 July 2026".'>
              <input
                id="p-updated"
                value={form.updatedLabel}
                onChange={(event) => setForm({ ...form, updatedLabel: event.target.value })}
                className="input"
              />
            </Field>
            <Field label="Search title" htmlFor="p-meta-title" hint={`${form.metaTitle.length}/70`}>
              <input
                id="p-meta-title"
                maxLength={70}
                value={form.metaTitle}
                onChange={(event) => setForm({ ...form, metaTitle: event.target.value })}
                className="input"
              />
            </Field>
            <Field label="Search description" htmlFor="p-meta-desc" hint={`${form.metaDescription.length}/170`}>
              <input
                id="p-meta-desc"
                maxLength={170}
                value={form.metaDescription}
                onChange={(event) => setForm({ ...form, metaDescription: event.target.value })}
                className="input"
              />
            </Field>
          </div>
        </div>
      </Modal>
    </>
  )
}
