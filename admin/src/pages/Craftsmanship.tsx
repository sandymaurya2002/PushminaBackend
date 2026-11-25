import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Plus, Trash2, Upload } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { Card, ErrorState, Field, LoadingBlock, PageHeader, Spinner, useToast } from '@/components/ui'
import { useAuth } from '@/lib/auth'
import { mediaPreview } from '@/lib/utils'

interface Stage {
  step: string
  heading: string
  duration: string
  body: string
  imageUrl: string
  imageAlt: string
}

interface CraftPage {
  eyebrow: string
  heading: string
  intro: string
  stages: Stage[]
}

interface UploadedAsset {
  path: string
}

function emptyStage(index: number): Stage {
  return {
    step: String(index + 1).padStart(2, '0'),
    heading: '',
    duration: '',
    body: '',
    imageUrl: '',
    imageAlt: '',
  }
}

function fromApi(data: CraftPage): CraftPage {
  return {
    eyebrow: data.eyebrow ?? '',
    heading: data.heading ?? '',
    intro: data.intro ?? '',
    stages: (data.stages ?? []).map((stage, index) => ({
      step: stage.step || String(index + 1).padStart(2, '0'),
      heading: stage.heading ?? '',
      duration: stage.duration ?? '',
      body: stage.body ?? '',
      imageUrl: stage.imageUrl ?? '',
      imageAlt: stage.imageAlt ?? '',
    })),
  }
}

/** Website → Craftsmanship. Each stage is the photograph and copy on /craftsmanship. */
export function Craftsmanship() {
  const { can } = useAuth()
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const canEdit = can('content.update')
  const fileInput = useRef<HTMLInputElement>(null)
  const [uploadTarget, setUploadTarget] = useState<number | null>(null)
  const [form, setForm] = useState<CraftPage | null>(null)

  const page = useQuery({
    queryKey: ['admin-craftsmanship'],
    queryFn: async () => fromApi((await api.get<CraftPage>('/admin/content/craftsmanship')).data),
  })

  const draft = form ?? page.data ?? null

  function update(next: CraftPage) {
    setForm(next)
  }

  function updateStage(index: number, patch: Partial<Stage>) {
    if (!draft) return
    update({
      ...draft,
      stages: draft.stages.map((stage, position) => (position === index ? { ...stage, ...patch } : stage)),
    })
  }

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const body = new FormData()
      body.append('files', file)
      body.append('folder', 'banners')
      return api.upload<UploadedAsset[]>('/admin/media', body)
    },
    onSuccess: (result) => {
      const asset = result.data[0]
      if (!asset || uploadTarget === null || !draft) return
      updateStage(uploadTarget, { imageUrl: asset.path })
      toast({ title: 'Image uploaded' })
    },
    onError: (caught) =>
      toast({
        title: 'Upload failed',
        description: caught instanceof ApiError ? caught.message : 'Unexpected error.',
        tone: 'error',
      }),
  })

  const save = useMutation({
    mutationFn: async () => {
      if (!draft) return
      return api.put('/admin/content/craftsmanship', {
        eyebrow: draft.eyebrow.trim() || null,
        heading: draft.heading.trim(),
        intro: draft.intro.trim() || null,
        stages: draft.stages.map((stage) => ({
          step: stage.step.trim(),
          heading: stage.heading.trim(),
          duration: stage.duration.trim(),
          body: stage.body.trim(),
          imageUrl: api.mediaPath(stage.imageUrl.trim()),
          imageAlt: stage.imageAlt.trim() || null,
        })),
      })
    },
    onSuccess: (result) => {
      const saved = fromApi((result?.data ?? draft) as CraftPage)
      setForm(saved)
      queryClient.setQueryData(['admin-craftsmanship'], saved)
      toast({ title: 'Craftsmanship page saved', description: 'The website updates within a minute.' })
    },
    onError: (caught) =>
      toast({
        title: 'Could not save',
        description: caught instanceof ApiError ? caught.message : 'Unexpected error.',
        tone: 'error',
      }),
  })

  if (page.isLoading) return <LoadingBlock rows={8} />
  if (page.error || !draft) return <ErrorState error={page.error} retry={() => void page.refetch()} />

  const missingImage = draft.stages.some((stage) => !stage.imageUrl.trim())

  return (
    <>
      <PageHeader
        title="Craftsmanship"
        description="The four stages on the Craftsmanship page. Upload a photograph for each one — the first stage is Combing."
        actions={
          canEdit && (
            <button
              type="button"
              onClick={() => save.mutate()}
              disabled={save.isPending || !draft.heading.trim() || draft.stages.length === 0 || missingImage}
              className="btn-primary"
            >
              {save.isPending && <Spinner />}
              Save page
            </button>
          )
        }
      />

      <input
        ref={fileInput}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/avif"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) upload.mutate(file)
        }}
      />

      <div className="space-y-6">
        <Card title="Introduction">
          <div className="grid gap-4 p-5">
            <Field label="Eyebrow" htmlFor="eyebrow">
              <input
                id="eyebrow"
                value={draft.eyebrow}
                onChange={(event) => update({ ...draft, eyebrow: event.target.value })}
                className="input"
                disabled={!canEdit}
              />
            </Field>
            <Field label="Heading" htmlFor="heading" required>
              <input
                id="heading"
                value={draft.heading}
                onChange={(event) => update({ ...draft, heading: event.target.value })}
                className="input"
                disabled={!canEdit}
              />
            </Field>
            <Field label="Introduction" htmlFor="intro">
              <textarea
                id="intro"
                rows={4}
                value={draft.intro}
                onChange={(event) => update({ ...draft, intro: event.target.value })}
                className="input h-auto py-2"
                disabled={!canEdit}
              />
            </Field>
          </div>
        </Card>

        {draft.stages.map((stage, index) => {
          const preview = mediaPreview(stage.imageUrl)
          return (
            <Card
              key={`${stage.step}-${index}`}
              title={`Stage ${stage.step || index + 1}`}
              actions={
                canEdit && (
                  <div className="flex gap-0.5">
                    <button
                      type="button"
                      aria-label="Move up"
                      disabled={index === 0}
                      onClick={() => {
                        const next = [...draft.stages]
                        ;[next[index - 1], next[index]] = [next[index]!, next[index - 1]!]
                        update({ ...draft, stages: next })
                      }}
                      className="p-1 text-taupe hover:text-charcoal disabled:opacity-30"
                    >
                      <ArrowUp className="h-3.5 w-3.5" strokeWidth={1.5} />
                    </button>
                    <button
                      type="button"
                      aria-label="Move down"
                      disabled={index === draft.stages.length - 1}
                      onClick={() => {
                        const next = [...draft.stages]
                        ;[next[index + 1], next[index]] = [next[index]!, next[index + 1]!]
                        update({ ...draft, stages: next })
                      }}
                      className="p-1 text-taupe hover:text-charcoal disabled:opacity-30"
                    >
                      <ArrowDown className="h-3.5 w-3.5" strokeWidth={1.5} />
                    </button>
                    <button
                      type="button"
                      aria-label="Remove stage"
                      disabled={draft.stages.length === 1}
                      onClick={() => update({ ...draft, stages: draft.stages.filter((_, position) => position !== index) })}
                      className="p-1 text-taupe hover:text-burgundy disabled:opacity-30"
                    >
                      <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                    </button>
                  </div>
                )
              }
            >
              <div className="grid gap-6 p-5 lg:grid-cols-[16rem_1fr]">
                <div>
                  <div className="aspect-[4/3] overflow-hidden border border-line bg-ivory-deep">
                    {preview && <img src={preview} alt="" className="h-full w-full object-cover" />}
                  </div>
                  {canEdit && can('media.upload') && (
                    <button
                      type="button"
                      className="btn-outline mt-3 w-full"
                      disabled={upload.isPending}
                      onClick={() => {
                        setUploadTarget(index)
                        fileInput.current?.click()
                      }}
                    >
                      {upload.isPending && uploadTarget === index ? <Spinner /> : <Upload className="h-3.5 w-3.5" strokeWidth={1.5} />}
                      Upload image
                    </button>
                  )}
                </div>

                <div className="grid gap-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Number" htmlFor={`step-${index}`} required>
                      <input
                        id={`step-${index}`}
                        value={stage.step}
                        onChange={(event) => updateStage(index, { step: event.target.value })}
                        className="input"
                        disabled={!canEdit}
                      />
                    </Field>
                    <Field label="Duration" htmlFor={`duration-${index}`} required hint="Shown under the heading, for example “Two weeks each spring”.">
                      <input
                        id={`duration-${index}`}
                        value={stage.duration}
                        onChange={(event) => updateStage(index, { duration: event.target.value })}
                        className="input"
                        disabled={!canEdit}
                      />
                    </Field>
                  </div>
                  <Field label="Heading" htmlFor={`heading-${index}`} required>
                    <input
                      id={`heading-${index}`}
                      value={stage.heading}
                      onChange={(event) => updateStage(index, { heading: event.target.value })}
                      className="input"
                      disabled={!canEdit}
                    />
                  </Field>
                  <Field label="Description" htmlFor={`body-${index}`} required>
                    <textarea
                      id={`body-${index}`}
                      rows={4}
                      value={stage.body}
                      onChange={(event) => updateStage(index, { body: event.target.value })}
                      className="input h-auto py-2"
                      disabled={!canEdit}
                    />
                  </Field>
                  <Field label="Image description" htmlFor={`alt-${index}`} hint="Read aloud to people who cannot see the photograph.">
                    <input
                      id={`alt-${index}`}
                      value={stage.imageAlt}
                      onChange={(event) => updateStage(index, { imageAlt: event.target.value })}
                      className="input"
                      disabled={!canEdit}
                    />
                  </Field>
                </div>
              </div>
            </Card>
          )
        })}

        {canEdit && draft.stages.length < 8 && (
          <button
            type="button"
            className="btn-outline"
            onClick={() => update({ ...draft, stages: [...draft.stages, emptyStage(draft.stages.length)] })}
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={2} />
            Add stage
          </button>
        )}
      </div>
    </>
  )
}
