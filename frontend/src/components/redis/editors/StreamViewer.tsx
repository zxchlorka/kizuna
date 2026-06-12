import { ArrowDown, ArrowUp, Waves } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { stringifyRedisValue } from '@/components/redis/redisUtils'
import type { ColumnMeta, TableRow } from '@/types/api'

interface StreamViewerProps {
  columns: ColumnMeta[]
  rows: TableRow[]
  meta: Record<string, unknown>
  loading: boolean
  onLoadOlder: () => void
  onLoadNewer: () => void
}

export function StreamViewer({ columns, rows, meta, loading, onLoadOlder, onLoadNewer }: StreamViewerProps) {
  const hasOlder = Boolean(meta.has_older)
  const hasNewer = Boolean(meta.has_newer)
  const total = typeof meta.length === 'number' ? meta.length : rows.length
  const consumerGroups = typeof meta.consumer_groups === 'number' ? meta.consumer_groups : 0

  return (
    <div className="overflow-hidden rounded-sm border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Redis stream</div>
          <div className="mt-1 flex items-center gap-2 text-sm text-foreground">
            <Waves className="h-4 w-4 text-orange-500" />
            {total} entries • {consumerGroups} consumer groups
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5 font-mono text-[11px]" onClick={onLoadNewer} disabled={loading || !hasNewer}>
            <ArrowUp className="h-3.5 w-3.5" />
            Load newer
          </Button>
          <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5 font-mono text-[11px]" onClick={onLoadOlder} disabled={loading || !hasOlder}>
            <ArrowDown className="h-3.5 w-3.5" />
            Load older
          </Button>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="px-4 py-8 text-sm text-muted-foreground">No stream entries in the current window.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-border text-sm">
            <thead className="bg-muted/30 text-left text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              <tr>
                {columns.map((column) => (
                  <th key={column.name} className="px-4 py-3 font-medium">
                    {column.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/70">
              {rows.map((row, index) => (
                <tr key={String(row.id ?? `stream-row-${index}`)}>
                  {columns.map((column) => (
                    <td key={column.name} className="max-w-[280px] px-4 py-3 font-mono text-xs text-foreground">
                      <div className="truncate">{stringifyRedisValue(row[column.name])}</div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
