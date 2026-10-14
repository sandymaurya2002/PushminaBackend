import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Star, X } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import {
  Card,
  EmptyState,
  ErrorState,
  LoadingBlock,
  Modal,
  PageHeader,
  Spinner,
  useToast,
} from '@/components/ui'
import { cn, formatPrice } from '@/lib/utils'

/**
 * Merchandising.
 *
 * The storefront's Trending, Featured and New Arrivals rails render exactly
 * what is selected here, in exactly this order. If a rail is left empty the
 * website falls back to an automatic selection rather than showing nothing.
 */

interface ProductRow {
  id: string
  name: string
  slug: string
  price: number
  priceUsd: number | null
  status: string
  isFeatured: boolean
  isTrending: boolean
  isNewArrival: boolean
  image: { url: string; alt: string } | null
  category: { name: string }
}

type Rail = 'trending' | 'featured' | 'newArrival'

const RAILS: Array<{ key: Rail; label: string; flag: keyof ProductRow; description: string }> = [
  {
    key: 'trending',
    label: 'Trending',
    flag: 'isTrending',
    description: 'The “Trending Now” rail on the homepage.',
  },
  {
    key: 'featured',
    label: 'Featured',
    flag: 'isFeatured',
    description: 'Given priority in the Featured sort and editorial placements.',
  },
  {
    key: 'newArrival',
    label: 'New Arrivals',
    flag: 'isNewArrival',
    description: 'The “New Arrivals” carousel on the homepage.',
  },
]

export function Merchandising() {
  const [rail, setRail] = useState<Rail>('trending')
  const [picking, setPicking] = useState(false)
  const [search, setSearch] = useState('')

  const { toast } = useToast()
  const queryClient = useQueryClient()

  const active = RAILS.find((entry) => entry.key === rail)!
  const flagParam = rail === 'newArrival' ? 'new' : rail

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['merchandising', rail],
    queryFn: async () =>
      (await api.get<ProductRow[]>('/admin/products', { flag: flagParam, limit: 100 })).data,
  })

  const { data: searchResults } = useQuery({
    queryKey: ['merchandising-search', search],
    queryFn: async () =>
      (await api.get<ProductRow[]>('/admin/products', { q: search, status: 'PUBLISHED', limit: 20 }))
        .data,
    enabled: picking && search.length >= 2,
  })

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['merchandising'] })

  const toggle = useMutation({
    mutationFn: async ({ id, on }: { id: string; on: boolean }) =>
      api.patch(`/admin/products/${id}/merchandising`, { [active.flag]: on }),
    onSuccess: (_result, variables) => {
      invalidate()
      toast({
        title: variables.on ? `Added to ${active.label}` : `Removed from ${active.label}`,
      })
    },
    onError: (caught) =>
      toast({
        title: 'Could not update',
        description: caught instanceof ApiError ? caught.message : 'Unexpected error.',
        tone: 'error',
      }),
  })

  const reorder = useMutation({
    mutationFn: async (ids: string[]) =>
      api.post('/admin/products/merchandising/reorder', { rail, ids }),
    onSuccess: invalidate,
  })

  function move(index: number, direction: -1 | 1) {
    if (!data) return
    const next = [...data]
    const target = index + direction
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    reorder.mutate(next.map((product) => product.id))
  }

  return (
    <>
      <PageHeader
        title="Merchandising"
        description="Choose exactly which products appear in each homepage rail, and in what order."
      />

      <div className="mb-6 flex flex-wrap gap-1 border-b border-line">
        {RAILS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            onClick={() => setRail(entry.key)}
            className={cn(
              'relative px-4 py-2.5 text-[0.75rem] uppercase tracking-[0.12em] transition-colors',
              rail === entry.key ? 'text-charcoal' : 'text-taupe hover:text-charcoal',
            )}
          >
            {entry.label}
            {rail === entry.key && (
              <span className="absolute inset-x-0 -bottom-px h-0.5 bg-gold" aria-hidden />
            )}
          </button>
        ))}
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-mocha">{active.description}</p>
        <button type="button" onClick={() => setPicking(true)} className="btn-primary">
          Add products
        </button>
      </div>

      <Card>
        {isLoading ? (
          <LoadingBlock rows={5} />
        ) : error ? (
          <ErrorState error={error} retry={() => void refetch()} />
        ) : !data?.length ? (
          <EmptyState
            icon={<Star className="h-6 w-6" strokeWidth={1} />}
            title={`Nothing in ${active.label} yet`}
            description="Until you choose products here, the website falls back to an automatic selection so the rail is never empty."
            action={
              <button type="button" onClick={() => setPicking(true)} className="btn-primary">
                Add products
              </button>
            }
          />
        ) : (
          <ul className="divide-y divide-line">
            {data.map((product, index) => (
              <li key={product.id} className="flex items-center gap-4 px-5 py-3">
                <span className="w-6 text-center font-serif text-lg text-taupe">{index + 1}</span>

                <div className="h-14 w-11 shrink-0 overflow-hidden bg-ivory-deep">
                  {product.image && (
                    <img src={product.image.url} alt="" className="h-full w-full object-cover" />
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-charcoal">{product.name}</p>
                  <p className="text-[0.6875rem] text-taupe">
                    {product.category.name} · {formatPrice(product.price)}
                    {product.priceUsd !== null && ` · ${formatPrice(product.priceUsd, 'USD')}`}
                  </p>
                </div>

                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => move(index, -1)}
                    disabled={index === 0 || reorder.isPending}
                    aria-label="Move up"
                    className="p-1.5 text-taupe transition-colors hover:text-charcoal disabled:opacity-30"
                  >
                    <ArrowUp className="h-3.5 w-3.5" strokeWidth={1.5} />
                  </button>
                  <button
                    type="button"
                    onClick={() => move(index, 1)}
                    disabled={index === data.length - 1 || reorder.isPending}
                    aria-label="Move down"
                    className="p-1.5 text-taupe transition-colors hover:text-charcoal disabled:opacity-30"
                  >
                    <ArrowDown className="h-3.5 w-3.5" strokeWidth={1.5} />
                  </button>
                  <button
                    type="button"
                    onClick={() => toggle.mutate({ id: product.id, on: false })}
                    aria-label={`Remove ${product.name}`}
                    className="p-1.5 text-taupe transition-colors hover:text-burgundy"
                  >
                    <X className="h-3.5 w-3.5" strokeWidth={1.5} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Modal
        open={picking}
        onClose={() => {
          setPicking(false)
          setSearch('')
        }}
        title={`Add to ${active.label}`}
      >
        <div className="space-y-4">
          <input
            autoFocus
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search published products…"
            className="input"
            aria-label="Search products"
          />

          {search.length < 2 ? (
            <p className="py-8 text-center text-sm text-taupe">
              Type at least two characters to search.
            </p>
          ) : !searchResults?.length ? (
            <p className="py-8 text-center text-sm text-taupe">No products match.</p>
          ) : (
            <ul className="divide-y divide-line">
              {searchResults.map((product) => {
                const already = Boolean(product[active.flag])
                return (
                  <li key={product.id} className="flex items-center gap-3 py-2.5">
                    <div className="h-12 w-9 shrink-0 overflow-hidden bg-ivory-deep">
                      {product.image && (
                        <img
                          src={product.image.url}
                          alt=""
                          className="h-full w-full object-cover"
                        />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-charcoal">{product.name}</p>
                      <p className="text-[0.6875rem] text-taupe">
                        {formatPrice(product.price)}
                        {product.priceUsd !== null && ` · ${formatPrice(product.priceUsd, 'USD')}`}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={already || toggle.isPending}
                      onClick={() => toggle.mutate({ id: product.id, on: true })}
                      className="btn-outline btn-sm"
                    >
                      {toggle.isPending && <Spinner />}
                      {already ? 'Added' : 'Add'}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </Modal>
    </>
  )
}
