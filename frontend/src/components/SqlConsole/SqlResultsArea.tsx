import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import { AlertTriangle, Rows3, SkipForward } from 'lucide-react'
import { EmptyState } from '@/components/EmptyState'
import { ExplainView } from '@/components/SqlConsole/ExplainView'
import { SqlResultCell } from '@/components/SqlConsole/SqlResultCell'
import { SqlResultTab } from '@/components/SqlConsole/SqlResultTab'
import { FloatingMenu, FloatingMenuItem, FloatingMenuLabel } from '@/components/ui/floating-menu'
import { useOpenLinkTarget } from '@/hooks/useOpenLinkTarget'
import type { SqlResultItem } from '@/stores/sqlConsole'
import { cn } from '@/lib/utils'
import { linkTargetLabel } from '@/lib/links'
import { getPostgresTypeBadge } from '@/lib/postgresTypes'
import { useLinksStore } from '@/stores/links'

interface SqlResultsAreaProps {
  results: SqlResultItem[]
  activeResultId: string | null
  onSelectResult: (resultId: string) => void
  connId: string
}

type SortState = {
  columnIndex: number
  direction: 'asc' | 'desc'
} | null

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function compareValues(left: unknown, right: unknown): number {
  const leftString = renderValue(left)
  const rightString = renderValue(right)
  return leftString.localeCompare(rightString, undefined, { numeric: true, sensitivity: 'base' })
}

function TypeBadge({ typeName }: { typeName: string }) {
  const badge = getPostgresTypeBadge(typeName)

  return (
    <span
      className={cn('inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-[10px] font-medium lowercase tracking-[0.04em]', badge.className)}
      title={badge.title}
    >
      {badge.label}
    </span>
  )
}

export function SqlResultsArea({ results, activeResultId, onSelectResult, connId }: SqlResultsAreaProps) {
  const [sortState, setSortState] = useState<SortState>(null)
  const activeResult = results.find((result) => result.id === activeResultId) ?? results[0] ?? null
  const openLinkTarget = useOpenLinkTarget()
  const linksFor = useLinksStore((state) => state.linksFor)
  const fetchLinks = useLinksStore((state) => state.fetch)
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; row: unknown[] } | null>(null)
  useEffect(() => {
    void fetchLinks().catch(() => undefined)
  }, [fetchLinks])

  useEffect(() => {
    setSortState(null)
  }, [activeResultId])

  const sortedRows = useMemo(() => {
    if (!activeResult || activeResult.kind !== 'execute' || !sortState) {
      return activeResult?.kind === 'execute' ? (activeResult.result.rows ?? []) : []
    }
    return [...(activeResult.result.rows ?? [])].sort((left, right) => {
      const comparison = compareValues(left[sortState.columnIndex], right[sortState.columnIndex])
      return sortState.direction === 'asc' ? comparison : -comparison
    })
  }, [activeResult, sortState])

  const activeExecuteResult = activeResult?.kind === 'execute' ? activeResult.result : null
  const truncatedLimit = activeExecuteResult?.applied_limit ?? activeExecuteResult?.rows_returned ?? 0

  if (results.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <EmptyState
          variant="no_results"
          title="No results yet"
          description="Run a statement, EXPLAIN plan, or ANALYZE plan to populate this area."
        />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex min-h-[38px] items-center overflow-x-auto border-b border-border bg-muted/20">
        {results.map((result) => (
          <SqlResultTab
            key={result.id}
            item={result}
            active={result.id === activeResult?.id}
            onClick={() => onSelectResult(result.id)}
          />
        ))}
      </div>

      <div className="flex-1 overflow-hidden">
        {!activeResult ? null : activeResult.kind === 'explain' ? (
          <ExplainView result={activeResult.result} />
        ) : activeResult.result.error ? (
          <div className="m-3 rounded-sm border border-red-500/40 bg-red-500/10 p-4">
            <div className="flex items-center gap-2 font-mono text-sm text-red-700 dark:text-red-300">
              <AlertTriangle className="h-4 w-4" />
              Statement {activeResult.statementIndex + 1} failed
            </div>
            <p className="mt-2 whitespace-pre-wrap font-mono text-xs text-red-700/90 dark:text-red-200">
              {activeResult.result.error}
            </p>
          </div>
        ) : activeResult.result.skipped ? (
          <div className="m-3 rounded-sm border border-border bg-muted/20 p-4">
            <div className="flex items-center gap-2 font-mono text-sm text-muted-foreground">
              <SkipForward className="h-4 w-4" />
              Statement skipped
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              This statement was skipped because a previous statement failed in the same batch.
            </p>
          </div>
        ) : (activeResult.result.columns?.length ?? 0) > 0 ? (
          <div className="flex h-full flex-col overflow-hidden">
            {activeExecuteResult?.truncated && (
              <div className="mx-3 mt-3 rounded-sm border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
                Showing first {truncatedLimit} rows. Add LIMIT/OFFSET to refine this query.
              </div>
            )}
            <div className="flex-1 overflow-auto">
            <table className="min-w-full border-collapse text-sm">
              <thead className="sticky top-0 z-10 bg-background">
                <tr>
                  {activeResult.result.columns.map((column, index) => {
                    const activeSort = sortState?.columnIndex === index ? sortState.direction : null
                    const columnType = activeResult.result.column_types?.[index] ?? 'unknown'
                    return (
                      <th key={column} className="border-b border-r border-border px-3 py-2 text-left font-mono text-[11px] text-muted-foreground">
                        <button
                          type="button"
                          className="flex flex-col items-start gap-1 hover:text-foreground"
                          onClick={() =>
                            setSortState((current) => {
                              if (!current || current.columnIndex !== index) {
                                return { columnIndex: index, direction: 'asc' }
                              }
                              if (current.direction === 'asc') {
                                return { columnIndex: index, direction: 'desc' }
                              }
                              return null
                            })
                          }
                        >
                          <span className="flex items-center gap-1">
                            <span>{column}</span>
                            <span className="text-[10px]">
                              {activeSort === 'asc' ? '▲' : activeSort === 'desc' ? '▼' : ''}
                            </span>
                          </span>
                          <TypeBadge typeName={columnType} />
                        </button>
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((row, rowIndex) => (
                  <tr
                    key={`${activeResult.id}-${rowIndex}`}
                    className="odd:bg-muted/10"
                    onContextMenu={(event: MouseEvent) => {
                      event.preventDefault()
                      setRowMenu({ x: event.clientX, y: event.clientY, row })
                    }}
                  >
                    {row.map((value, columnIndex) => (
                      <td key={`${activeResult.id}-${rowIndex}-${columnIndex}`} className="max-w-[320px] border-b border-r border-border/70 px-3 py-2 align-top font-mono text-[12px] text-foreground">
                        <SqlResultCell
                          value={value}
                          columnName={activeResult.result.columns[columnIndex] ?? `column_${columnIndex + 1}`}
                          columnType={activeResult.result.column_types?.[columnIndex]}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {rowMenu && activeExecuteResult && (
              <FloatingMenu x={rowMenu.x} y={rowMenu.y} onClose={() => setRowMenu(null)}>
                <FloatingMenuLabel>Open linked record</FloatingMenuLabel>
                {(() => {
                  const items: JSX.Element[] = []
                  const sources = activeExecuteResult.column_sources ?? []
                  sources.forEach((src, columnIndex) => {
                    if (!src) return
                    const value = renderValue(rowMenu.row[columnIndex])
                    linksFor(connId, src.table)
                      .filter((link) => link.source_kind === 'postgres' && link.source_field === src.column)
                      .forEach((link) => {
                        items.push(
                          <FloatingMenuItem
                            key={`${link.id}-${columnIndex}`}
                            onClick={() => {
                              openLinkTarget(link, value)
                              setRowMenu(null)
                            }}
                          >
                            {linkTargetLabel(link, value)}
                          </FloatingMenuItem>
                        )
                      })
                  })
                  if (items.length === 0) {
                    return <FloatingMenuItem disabled>No links for these columns</FloatingMenuItem>
                  }
                  return items
                })()}
              </FloatingMenu>
            )}
            {sortedRows.length === 0 && (
              <div className="p-4">
                <EmptyState variant="no_data" compact title="0 rows returned" description="This query ran successfully but returned no rows." />
              </div>
            )}
            </div>
          </div>
        ) : (
          <div className="m-3 rounded-sm border border-border bg-muted/20 p-4">
            <div className="flex items-center gap-2 font-mono text-sm text-foreground">
              <Rows3 className="h-4 w-4 text-emerald-500" />
              Statement {activeResult.statementIndex + 1} completed
            </div>
            <p className="mt-2 font-mono text-xs text-muted-foreground">
              {activeResult.result.rows_affected} row{activeResult.result.rows_affected === 1 ? '' : 's'} affected
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
