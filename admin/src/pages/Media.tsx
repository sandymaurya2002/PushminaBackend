import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Image as ImageIcon, Trash2, Upload } from 'lucide-react'
import { api, ApiError, type ApiMeta } from '@/lib/api'
import {
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LoadingBlock,
  PageHeader,
  Pagination,
  Spinner,
  useToast,
} from '@/components/ui'
import { useAuth } from '@/lib/auth'

interface Asset {
  id: string
  filename: string
  originalName: string
  mimeType: string
  size: number
  width: number | null
  height: number | null
  url: string
  thumbnailUrl: string | null
  folder: string
  alt: string | null
  createdAt: string
  uploadedBy: { id: string; name: string } | null
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function Media() {
  const { can } = useAuth()
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const fileInput = useRef<HTMLInputElement>(null)

  const [page, setPage] = useState(1)
  const [folder, setFolder] = useState('')
  const [deleting, setDeleting] = useState<Asset | null>(null)

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin-media', page, folder],
    queryFn: async () => {
      const result = await api.get<Asset[]>('/admin/media', {
        page,
        limit: 36,
        folder: folder || undefined,
      })
      return { rows: result.data, meta: result.meta as ApiMeta }
    },
  })

  const uploadMutation = useMutation({
    mutationFn: async (files: FileList) => {
      const formData = new FormData()
      Array.from(files).forEach((file) => formData.append('files', file))
      formData.append('folder', folder || 'general')
      return api.upload<Asset[]>('/admin/media', formData)
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['admin-media'] })
      toast({
        title: 'Uploaded',
        description: `${result.data.length} file${result.data.length === 1 ? '' : 's'} added.`,
      })
    },
    onError: (caught) =>
      toast({
        title: 'Upload failed',
        description: caught instanceof ApiError ? caught.message : 'Unexpected error.',
        tone: 'error',
      }),
  })

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => api.delete(`/admin/media/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-media'] })
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

  const folders = (data?.meta?.folders ?? []) as string[]

  return (
    <>
      <PageHeader
        title="Media library"
        description="Images used across products, banners and the journal. Uploads are resized and given a thumbnail automatically."
        actions={
          can('media.upload') && (
            <>
              <input
                ref={fileInput}
                type="file"
                multiple
                accept="image/*,video/mp4,video/webm"
                className="hidden"
                onChange={(event) => {
                  if (event.target.files?.length) uploadMutation.mutate(event.target.files)
                  event.target.value = ''
                }}
              />
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                disabled={uploadMutation.isPending}
                className="btn-primary"
              >
                {uploadMutation.isPending ? (
                  <Spinner />
                ) : (
                  <Upload className="h-3.5 w-3.5" strokeWidth={1.5} />
                )}
                Upload
              </button>
            </>
          )
        }
      />

      <div className="mb-4 flex flex-wrap gap-1">
        <button
          type="button"
          onClick={() => {
            setFolder('')
            setPage(1)
          }}
          className={`chip transition-colors ${
            !folder
              ? 'border-charcoal bg-charcoal text-ivory'
              : 'border-line-strong text-mocha hover:border-charcoal'
          }`}
        >
          All
        </button>
        {folders.map((entry) => (
          <button
            key={entry}
            type="button"
            onClick={() => {
              setFolder(entry)
              setPage(1)
            }}
            className={`chip transition-colors ${
              folder === entry
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
          <LoadingBlock rows={6} />
        ) : error ? (
          <ErrorState error={error} retry={() => void refetch()} />
        ) : !data?.rows.length ? (
          <EmptyState
            icon={<ImageIcon className="h-6 w-6" strokeWidth={1} />}
            title="No media yet"
            description="Upload product photography, banners and journal covers here."
          />
        ) : (
          <>
            <ul className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
              {data.rows.map((asset) => (
                <li key={asset.id} className="group relative border border-line">
                  <div className="aspect-[4/5] overflow-hidden bg-ivory-deep">
                    {asset.mimeType.startsWith('image/') ? (
                      <img
                        src={asset.thumbnailUrl ?? asset.url}
                        alt={asset.alt ?? ''}
                        loading="lazy"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center text-taupe">
                        <ImageIcon className="h-6 w-6" strokeWidth={1} />
                      </div>
                    )}
                  </div>

                  <div className="p-2">
                    <p className="truncate text-[0.6875rem] text-charcoal" title={asset.originalName}>
                      {asset.originalName}
                    </p>
                    <p className="text-[0.625rem] text-taupe">
                      {asset.width && asset.height ? `${asset.width}×${asset.height} · ` : ''}
                      {formatBytes(asset.size)}
                    </p>
                  </div>

                  <div className="absolute right-1.5 top-1.5 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard.writeText(asset.url)
                        toast({ title: 'URL copied' })
                      }}
                      aria-label="Copy URL"
                      className="flex h-7 w-7 items-center justify-center bg-ivory/90 text-charcoal backdrop-blur-sm hover:bg-ivory"
                    >
                      <Copy className="h-3 w-3" strokeWidth={1.5} />
                    </button>
                    {can('media.delete') && (
                      <button
                        type="button"
                        onClick={() => setDeleting(asset)}
                        aria-label="Delete"
                        className="flex h-7 w-7 items-center justify-center bg-ivory/90 text-burgundy backdrop-blur-sm hover:bg-ivory"
                      >
                        <Trash2 className="h-3 w-3" strokeWidth={1.5} />
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>

            <Pagination
              page={data.meta?.page ?? 1}
              totalPages={data.meta?.totalPages ?? 1}
              total={data.meta?.total ?? 0}
              onChange={setPage}
            />
          </>
        )}
      </Card>

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && deleteMutation.mutate(deleting.id)}
        busy={deleteMutation.isPending}
        title="Delete this file?"
        message="The file is removed from disk permanently. If it is still used by a product, banner or article, the deletion will be refused."
      />
    </>
  )
}
