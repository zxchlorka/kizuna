import { useCallback, useEffect, useState } from 'react'
import { Activity, Database, Gauge, Layers, RefreshCw, Timer } from 'lucide-react'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { Button } from '@/components/ui/button'
import { fetchWithTimeout } from '@/lib/http'
import { cn } from '@/lib/utils'
import { useConnectionStore } from '@/stores/connections'
import type { ColumnMeta } from '@/types/api'

interface PostgresOverviewProps {
  connId: string
}

type Section = 'activity' | 'statements' | 'tables' | 'replication'

interface StatsResult {
  columns: ColumnMeta[]
  rows: Array<Record<string, unknown>>
  meta?: { hint?: string }
}

const sections: Array<{ id: Section; label: string; icon: typeof Activity; blurb: string }> = [
  {
    id: 'activity',
    label: 'Activity',
    icon: Activity,
    blurb:
      'Sessions doing something, blocked ones first. A session idle inside a transaction runs nothing while holding locks and keeping autovacuum out.',
  },
  {
    id: 'statements',
    label: 'Top queries',
    icon: Timer,
    blurb:
      'Ordered by total time, not by how slow one call looks: a 3 ms query run ten million times is the one worth finding.',
  },
  {
    id: 'tables',
    label: 'Tables',
    icon: Layers,
    blurb: 'Size next to neglect — a large table autovacuum has not visited explains a lot of mysteries.',
  },
  {
    id: 'replication',
    label: 'Replication',
    icon: Gauge,
    blurb: 'How far each replica is behind, in bytes and in time. Bytes say how much, time says how long.',
  },
]

// Numbers are right-aligned so magnitudes line up in a monospace column; the
// query text is the only column that wants the full width it can get.
function alignFor(name: string): string {
  if (name === 'query') return 'text-left'
  return /(_ms|_rows|_pct|calls|rows|pid)$/.test(name) ? 'text-right tabular-nums' : 'text-left'
}

function renderCell(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export function PostgresOverview({ connId }: PostgresOverviewProps) {
  const connection = useConnectionStore((state) => state.connections.find((item) => item.id === connId))
  const [section, setSection] = useState<Section>('activity')
  const [result, setResult] = useState<StatsResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const res = await fetchWithTimeout(`/api/connections/${connId}/stats?section=${section}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(body.error || 'Failed to load server statistics')
      }
      setResult((await res.json()) as StatsResult)
    } catch (loadError) {
      setError((loadError as Error).message)
    } finally {
      setLoading(false)
    }
  }, [connId, section])

  useEffect(() => {
    void load()
  }, [load])

  const active = sections.find((item) => item.id === section)

  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="mx-auto flex max-w-6xl flex-col gap-3">
        <div className="rounded-sm border border-border bg-card p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-sm border border-blue-500/30 bg-blue-500/5">
                <Database className="h-5 w-5 text-blue-500" />
              </div>
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Postgres overview</div>
                <div className="mt-1 truncate font-mono text-lg">{connection?.name ?? connId}</div>
              </div>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 shrink-0 gap-1.5 font-mono text-[11px]"
              disabled={loading}
              onClick={() => void load()}
            >
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
              Refresh
            </Button>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-1">
            {sections.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setSection(id)}
                // Named for assistive tech because the sidebar carries a tree
                // filter with the same word on it.
                aria-label={`${label} section`}
                aria-pressed={section === id}
                className={cn(
                  'flex items-center gap-1.5 rounded-sm border px-2.5 py-1.5 font-mono text-[11px] transition-colors',
                  section === id
                    ? 'border-blue-500/40 bg-blue-500/5 text-blue-600 dark:text-blue-400'
                    : 'border-transparent text-muted-foreground hover:bg-muted'
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>
        </div>

        {active && <div className="px-1 font-mono text-[11px] leading-relaxed text-muted-foreground">{active.blurb}</div>}

        {loading && <LoadingSkeleton variant="table" />}

        {!loading && error && (
          <div className="rounded-sm border border-destructive/40 bg-destructive/5 px-3 py-3 font-mono text-xs leading-relaxed text-destructive">
            {error}
          </div>
        )}

        {!loading && !error && result && (
          <div className="rounded-sm border border-border">
            <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
              <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                {result.rows.length} {result.rows.length === 1 ? 'row' : 'rows'}
              </div>
              {/* The scope of the numbers travels with them: a figure that does
                  not say what it covers is the one that gets misread. */}
              {result.meta?.hint && (
                <div className="font-mono text-[11px] text-muted-foreground">{result.meta.hint}</div>
              )}
            </div>

            {result.rows.length === 0 ? (
              <div className="px-3 py-8 text-center font-mono text-xs text-muted-foreground">
                Nothing to report right now.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full font-mono text-xs">
                  <thead>
                    <tr className="border-b border-border text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                      {result.columns.map((column) => (
                        <th key={column.name} className={cn('px-3 py-2 font-normal', alignFor(column.name))}>
                          {column.name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((row, index) => (
                      <tr key={index} className="border-b border-border/50 last:border-b-0 hover:bg-muted/40">
                        {result.columns.map((column) => (
                          <td
                            key={column.name}
                            className={cn(
                              'px-3 py-1.5 align-top',
                              alignFor(column.name),
                              column.name === 'query' && 'whitespace-pre-wrap break-words',
                              // A blocked session is the reason this screen was
                              // opened; it should not need hunting for.
                              column.name === 'blocked_by' && row[column.name] ? 'text-amber-600 dark:text-amber-400' : ''
                            )}
                          >
                            {renderCell(row[column.name])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
