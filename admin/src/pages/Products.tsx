import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Package, Plus, Search } from 'lucide-react'
import { api, type ApiMeta } from '@/lib/api'
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  LoadingBlock,
  PageHeader,
  Pagination,
} from '@/components/ui'
import { useAuth } from '@/lib/auth'
import { cn, formatPrice, PRODUCT_STATUS_TONE } from '@/lib/utils'

interface ProductRow {
  id: string
  slug: string
  name: string
  status: string
  price: number
  compareAtPrice: number | null
  /** Null until an international price is entered; such products are not sold outside India. */
  priceUsd: number | null
  compareAtPriceUsd: number | null
  inventory: number
  variantCount: number
  stockState: 'in' | 'low' | 'out'
  isFeatured: boolean
  isTrending: boolean
  isNewArrival: boolean
  category: { id: string; name: string }
  material: { id: string; name: string }
  image: { url: string; alt: string } | null
  _count: { reviews: number; orderItems: number }
}

const STOCK_TONE = {
  in: 'border-success/40 text-success',
  low: 'border-gold/50 text-gold',
  out: 'border-burgundy/40 text-burgundy',
}

const STOCK_LABEL = { in: 'In stock', low: 'Low', out: 'Out' }

export function Products() {
  const [params, setParams] = useSearchParams()
  const { can } = useAuth()

  const [search, setSearch] = useState(params.get('q') ?? '')
  const page = Number(params.get('page') ?? 1)

  const filters = {
    q: params.get('q') ?? undefined,
    status: params.get('status') ?? undefined,
    stock: params.get('stock') ?? undefined,
    flag: params.get('flag') ?? undefined,
    pricing: params.get('pricing') ?? undefined,
    sort: params.get('sort') ?? 'newest',
    page,
    limit: 25,
  }

  // Debounce the search box so every keystroke is not a request.
  useEffect(() => {
    const timer = setTimeout(() => {
      const next = new URLSearchParams(params)
      if (search) next.set('q', search)
      else next.delete('q')
      next.delete('page')
      if (next.toString() !== params.toString()) setParams(next, { replace: true })
    }, 350)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin-products', filters],
    queryFn: async () => {
      const result = await api.get<ProductRow[]>('/admin/products', filters)
      return { rows: result.data, meta: result.meta as ApiMeta }
    },
  })

  const missingUsd = (data?.meta?.counts as { missingUsd?: number } | undefined)?.missingUsd ?? 0

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    next.delete('page')
    setParams(next)
  }

  return (
    <>
      <PageHeader
        title="Products"
        description="Everything in the catalogue. Filter by status, stock level or merchandising flag."
        actions={
          can('products.create') && (
            <Link to="/products/new" className="btn-primary">
              <Plus className="h-3.5 w-3.5" strokeWidth={2} />
              New product
            </Link>
          )
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[16rem] flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-taupe"
            strokeWidth={1.5}
            aria-hidden
          />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by name, slug or SKU…"
            className="input pl-9"
            aria-label="Search products"
          />
        </div>

        <select
          value={params.get('status') ?? ''}
          onChange={(event) => setFilter('status', event.target.value)}
          className="input w-auto"
          aria-label="Filter by status"
        >
          <option value="">All statuses</option>
          <option value="PUBLISHED">Published</option>
          <option value="DRAFT">Draft</option>
          <option value="ARCHIVED">Archived</option>
        </select>

        <select
          value={params.get('stock') ?? ''}
          onChange={(event) => setFilter('stock', event.target.value)}
          className="input w-auto"
          aria-label="Filter by stock"
        >
          <option value="">Any stock</option>
          <option value="in">In stock</option>
          <option value="low">Low stock</option>
          <option value="out">Out of stock</option>
        </select>

        <select
          value={params.get('flag') ?? ''}
          onChange={(event) => setFilter('flag', event.target.value)}
          className="input w-auto"
          aria-label="Filter by merchandising"
        >
          <option value="">All products</option>
          <option value="featured">Featured</option>
          <option value="trending">Trending</option>
          <option value="new">New arrivals</option>
        </select>

        <select
          value={params.get('pricing') ?? ''}
          onChange={(event) => setFilter('pricing', event.target.value)}
          className="input w-auto"
          aria-label="Filter by pricing"
        >
          <option value="">Any pricing</option>
          <option value="missing-usd">
            Missing USD price{missingUsd ? ` (${missingUsd})` : ''}
          </option>
        </select>

        <select
          value={params.get('sort') ?? 'newest'}
          onChange={(event) => setFilter('sort', event.target.value)}
          className="input w-auto"
          aria-label="Sort"
        >
          <option value="newest">Newest</option>
          <option value="oldest">Oldest</option>
          <option value="name">Name</option>
          <option value="price-low">Price: low to high</option>
          <option value="price-high">Price: high to low</option>
          <option value="popularity">Popularity</option>
        </select>
      </div>

      <Card>
        {isLoading ? (
          <LoadingBlock rows={8} />
        ) : error ? (
          <ErrorState error={error} retry={() => void refetch()} />
        ) : !data?.rows.length ? (
          <EmptyState
            icon={<Package className="h-6 w-6" strokeWidth={1} />}
            title="No products match"
            description="Try clearing the filters, or add your first product."
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[56rem]">
                <thead>
                  <tr>
                    <th className="th w-14" />
                    <th className="th">Product</th>
                    <th className="th">Category</th>
                    <th className="th text-right">Price</th>
                    <th className="th text-right">Stock</th>
                    <th className="th">Status</th>
                    <th className="th">Flags</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((product) => (
                    <tr key={product.id} className="transition-colors hover:bg-cream/40">
                      <td className="td">
                        <div className="h-12 w-10 overflow-hidden bg-ivory-deep">
                          {product.image && (
                            <img
                              src={product.image.url}
                              alt=""
                              className="h-full w-full object-cover"
                              loading="lazy"
                            />
                          )}
                        </div>
                      </td>

                      <td className="td">
                        <Link
                          to={`/products/${product.id}`}
                          className="block max-w-xs truncate text-charcoal transition-colors hover:text-gold"
                        >
                          {product.name}
                        </Link>
                        <span className="mt-0.5 block text-[0.6875rem] text-taupe">
                          {product.material.name} · {product.variantCount} variant
                          {product.variantCount === 1 ? '' : 's'}
                        </span>
                      </td>

                      <td className="td text-mocha">{product.category.name}</td>

                      <td className="td text-right">
                        <span className="text-charcoal">{formatPrice(product.price)}</span>
                        {product.compareAtPrice && (
                          <span className="ml-1.5 text-xs text-taupe line-through">
                            {formatPrice(product.compareAtPrice)}
                          </span>
                        )}
                        <span className="mt-0.5 block text-xs">
                          {product.priceUsd !== null ? (
                            <span className="text-mocha">{formatPrice(product.priceUsd, 'USD')}</span>
                          ) : (
                            <span className="text-burgundy">No USD price</span>
                          )}
                        </span>
                      </td>

                      <td className="td text-right">
                        <Badge className={STOCK_TONE[product.stockState]}>
                          {product.inventory} · {STOCK_LABEL[product.stockState]}
                        </Badge>
                      </td>

                      <td className="td">
                        <Badge className={PRODUCT_STATUS_TONE[product.status]}>
                          {product.status}
                        </Badge>
                      </td>

                      <td className="td">
                        <div className="flex flex-wrap gap-1">
                          {product.isTrending && (
                            <span className="chip border-gold/40 text-gold">Trending</span>
                          )}
                          {product.isFeatured && (
                            <span className="chip border-charcoal/30 text-charcoal">Featured</span>
                          )}
                          {product.isNewArrival && (
                            <span className="chip border-line-strong text-mocha">New</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <Pagination
              page={data.meta?.page ?? 1}
              totalPages={data.meta?.totalPages ?? 1}
              total={data.meta?.total ?? 0}
              onChange={(next) => {
                const params2 = new URLSearchParams(params)
                params2.set('page', String(next))
                setParams(params2)
                window.scrollTo({ top: 0 })
              }}
            />
          </>
        )}
      </Card>

      <p className={cn('mt-4 text-xs text-taupe')}>
        Products that appear in an order cannot be deleted — archive them instead, which removes
        them from the website while keeping order history intact.
      </p>
    </>
  )
}
