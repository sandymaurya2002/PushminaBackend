import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { BarChart3, Download } from 'lucide-react'
import { api } from '@/lib/api'
import { Card, EmptyState, ErrorState, LoadingBlock, PageHeader, useToast } from '@/components/ui'
import { useAuth } from '@/lib/auth'
import { CURRENCIES, type Currency, formatDate, formatNumber, formatPrice, titleCase } from '@/lib/utils'

type ReportRow = Record<string, string | number | null>

const REPORTS = [
  { id: 'sales', label: 'Sales by day', description: 'Booked revenue, discounts, refunds and cancellations per day.' },
  { id: 'products', label: 'Products', description: 'Units and revenue per product and SKU.' },
  { id: 'payments', label: 'Payments', description: 'Gateway and cash-on-delivery payments by method and status.' },
  { id: 'customers', label: 'Customers', description: 'Customers who registered or ordered in the period, by spend.' },
] as const

const MONEY = new Set(['subtotal', 'discount', 'shipping', 'tax', 'total', 'refunded', 'net', 'revenue', 'amount', 'spentInr', 'spentUsd'])
const TOTALLED = new Set([...MONEY, 'orders', 'units', 'count', 'cancelled', 'returns'])
const PRESETS = [7, 30, 90, 365]

/** Money columns whose currency is fixed by the column itself rather than the row. */
const COLUMN_CURRENCY: Record<string, Currency> = { spentInr: 'INR', spentUsd: 'USD' }

function rowCurrency(row: ReportRow): Currency {
  return row.currency === 'USD' ? 'USD' : 'INR'
}

function formatCell(column: string, value: string | number | null, currency: Currency = 'INR'): string {
  if (value === null || value === '') return '—'
  if (MONEY.has(column)) return formatPrice(Number(value), COLUMN_CURRENCY[column] ?? currency)
  if (column === 'registered' || column === 'day') return formatDate(String(value))
  if (typeof value === 'number') return formatNumber(value)
  if (column === 'status' || column === 'method' || column === 'provider') return titleCase(String(value))
  return String(value)
}

export function Reports() {
  const [params, setParams] = useSearchParams()
  const { can } = useAuth()
  const { toast } = useToast()

  const type = params.get('type') ?? 'sales'
  const from = params.get('from') ?? ''
  const to = params.get('to') ?? ''
  const days = Number(params.get('days') ?? 30)
  const range = from || to ? { from: from || undefined, to: to || undefined } : { days }

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin-report', type, range],
    queryFn: async () => {
      const result = await api.get<ReportRow[]>('/admin/reports', { type, ...range })
      const meta = result.meta as { columns?: string[]; from?: string; to?: string } | undefined
      return { rows: result.data, columns: meta?.columns ?? [], from: meta?.from, to: meta?.to }
    },
  })

  function update(changes: Record<string, string | null>) {
    const next = new URLSearchParams(params)
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value)
      else next.delete(key)
    }
    setParams(next)
  }

  async function exportCsv() {
    try {
      await api.download('/admin/reports/export', { type, ...range })
      toast({ title: 'Export started', description: 'Your CSV is downloading.' })
    } catch {
      toast({ title: 'Export failed', tone: 'error' })
    }
  }

  const active = REPORTS.find((report) => report.id === type) ?? REPORTS[0]
  // Rows in different currencies are totalled separately, one footer line per currency.
  const totals = data
    ? CURRENCIES.filter((currency) =>
        data.columns.includes('currency') ? data.rows.some((row) => rowCurrency(row) === currency) : currency === 'INR',
      ).map((currency) => {
        const rows = data.columns.includes('currency')
          ? data.rows.filter((row) => rowCurrency(row) === currency)
          : data.rows
        const sums = data.columns.reduce<Record<string, number>>((sum, column) => {
          if (TOTALLED.has(column)) sum[column] = rows.reduce((acc, row) => acc + Number(row[column] ?? 0), 0)
          return sum
        }, {})
        return { currency, sums }
      })
    : []
  const labelTotals = totals.length > 1

  return (
    <>
      <PageHeader
        title="Reports"
        description={active.description}
        actions={
          can('reports.export') && (
            <button type="button" onClick={exportCsv} className="btn-outline" disabled={!data?.rows.length}>
              <Download className="h-3.5 w-3.5" strokeWidth={1.5} />
              Export CSV
            </button>
          )
        }
      />

      <div className="mb-4 flex flex-wrap gap-1">
        {REPORTS.map((report) => (
          <button
            key={report.id}
            type="button"
            onClick={() => update({ type: report.id })}
            className={`chip transition-colors ${
              type === report.id
                ? 'border-charcoal bg-charcoal text-ivory'
                : 'border-line-strong text-mocha hover:border-charcoal'
            }`}
          >
            {report.label}
          </button>
        ))}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            onClick={() => update({ days: String(preset), from: null, to: null })}
            className={`chip transition-colors ${
              !from && !to && days === preset
                ? 'border-gold bg-gold/10 text-charcoal'
                : 'border-line-strong text-mocha hover:border-charcoal'
            }`}
          >
            Last {preset} days
          </button>
        ))}
        <span className="mx-1 text-xs text-taupe">or</span>
        <input
          type="date"
          value={from}
          onChange={(event) => update({ from: event.target.value, days: null })}
          className="input w-auto"
          aria-label="From date"
        />
        <input
          type="date"
          value={to}
          onChange={(event) => update({ to: event.target.value, days: null })}
          className="input w-auto"
          aria-label="To date"
        />
      </div>

      <Card>
        {isLoading ? (
          <LoadingBlock rows={8} />
        ) : error ? (
          <ErrorState error={error} retry={() => void refetch()} />
        ) : !data?.rows.length ? (
          <EmptyState
            icon={<BarChart3 className="h-6 w-6" strokeWidth={1} />}
            title="Nothing in this period"
            description="Try a wider date range."
          />
        ) : (
          <>
            {data.from && data.to && (
              <p className="border-b border-line px-5 py-3 text-xs text-taupe">
                {formatDate(data.from)} – {formatDate(data.to)} · {data.rows.length} rows
              </p>
            )}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem]">
                <thead>
                  <tr>
                    {data.columns.map((column) => (
                      <th key={column} className={`th ${TOTALLED.has(column) ? 'text-right' : ''}`}>
                        {titleCase(column)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row, index) => (
                    <tr key={index} className="transition-colors hover:bg-cream/40">
                      {data.columns.map((column) => (
                        <td
                          key={column}
                          className={`td text-sm ${TOTALLED.has(column) ? 'text-right text-charcoal' : 'text-mocha'}`}
                        >
                          {formatCell(column, row[column] ?? null, rowCurrency(row))}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                {totals.length > 0 && Object.keys(totals[0]!.sums).length > 0 && (
                  <tfoot>
                    {totals.map(({ currency, sums }, line) => (
                      <tr key={currency} className={line === 0 ? 'border-t border-line-strong' : undefined}>
                        {data.columns.map((column, index) => (
                          <td key={column} className={`td text-sm font-medium text-charcoal ${TOTALLED.has(column) ? 'text-right' : ''}`}>
                            {column in sums
                              ? formatCell(column, sums[column] ?? 0, currency)
                              : index === 0
                                ? labelTotals
                                  ? `Total (${currency})`
                                  : 'Total'
                                : ''}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tfoot>
                )}
              </table>
            </div>
          </>
        )}
      </Card>
    </>
  )
}
