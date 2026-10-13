import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { FileText } from 'lucide-react'
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
import { formatDateTime, titleCase } from '@/lib/utils'

interface AuditRow {
  id: string
  action: string
  entityType: string
  entityId: string | null
  ip: string | null
  createdAt: string
  adminUser: { id: string; name: string; email: string } | null
}

const ENTITY_TYPES = [
  'product',
  'order',
  'customer',
  'category',
  'collection',
  'color',
  'size',
  'material',
  'pattern',
  'media',
  'admin',
  'user',
]

export function Audit() {
  const [page, setPage] = useState(1)
  const [entityType, setEntityType] = useState('')

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin-audit', page, entityType],
    queryFn: async () => {
      const result = await api.get<AuditRow[]>('/admin/audit', {
        page,
        limit: 50,
        entityType: entityType || undefined,
      })
      return { rows: result.data, meta: result.meta as ApiMeta }
    },
  })

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every change made in the admin panel, with who made it and when."
      />

      <div className="mb-4">
        <select
          value={entityType}
          onChange={(event) => {
            setEntityType(event.target.value)
            setPage(1)
          }}
          className="input w-auto"
          aria-label="Filter by type"
        >
          <option value="">All types</option>
          {ENTITY_TYPES.map((type) => (
            <option key={type} value={type}>
              {titleCase(type)}
            </option>
          ))}
        </select>
      </div>

      <Card>
        {isLoading ? (
          <LoadingBlock rows={10} />
        ) : error ? (
          <ErrorState error={error} retry={() => void refetch()} />
        ) : !data?.rows.length ? (
          <EmptyState
            icon={<FileText className="h-6 w-6" strokeWidth={1} />}
            title="No activity recorded"
            description="Admin actions are logged here as they happen."
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[42rem]">
                <thead>
                  <tr>
                    <th className="th">When</th>
                    <th className="th">Who</th>
                    <th className="th">Action</th>
                    <th className="th">Type</th>
                    <th className="th">Record</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((entry) => (
                    <tr key={entry.id} className="transition-colors hover:bg-cream/40">
                      <td className="td whitespace-nowrap text-xs text-mocha">
                        {formatDateTime(entry.createdAt)}
                      </td>
                      <td className="td">
                        <span className="text-sm text-charcoal">
                          {entry.adminUser?.name ?? 'System'}
                        </span>
                        {entry.ip && (
                          <span className="mt-0.5 block text-[0.6875rem] text-taupe">
                            {entry.ip}
                          </span>
                        )}
                      </td>
                      <td className="td">
                        <Badge className="border-line-strong text-mocha">
                          {titleCase(entry.action)}
                        </Badge>
                      </td>
                      <td className="td text-mocha">{titleCase(entry.entityType)}</td>
                      <td className="td">
                        {entry.entityId && (
                          <code className="text-[0.6875rem] text-taupe">{entry.entityId}</code>
                        )}
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
              onChange={setPage}
            />
          </>
        )}
      </Card>
    </>
  )
}
