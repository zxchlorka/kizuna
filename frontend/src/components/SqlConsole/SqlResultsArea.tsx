import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import { AlertTriangle, Ban, Rows3, SkipForward } from 'lucide-react'
import { EmptyState } from '@/components/EmptyState'
import { ExplainView } from '@/components/SqlConsole/ExplainView'
import { SqlResultCell } from '@/components/SqlConsole/SqlResultCell'
import { SqlResultTab } from '@/components/SqlConsole/SqlResultTab'
import { TableExportMenu } from '@/components/TableExportMenu'
import { TableCheckbox } from '@/components/DataTable/TableCheckbox'
import { FloatingMenu, FloatingMenuItem, FloatingMenuLabel, FloatingMenuSeparator } from '@/components/ui/floating-menu'
import { useOpenLinkTarget } from '@/hooks/useOpenLink'
import type { SqlResultItem } from '@/stores/sqlConsole'
import { cn } from '@/lib/utils'
import { linkTargetLabel } from '@/lib/links'
import { getPostgresTypeBadge } from '@/lib/postgresTypes'
import { clipboardFailureMessage, writeClipboardText } from '@/lib/clipboard'
import { buildCSV, buildJSON, buildTSV, copySingleCellText, downloadTextFile, timestampForFilename, type ExportColumn } from '@/lib/tableExport'
import { useLinksStore } from '@/stores/links'
import { useToastStore } from '@/stores/toast'

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
  const pushToast = useToastStore((state) => state.push)
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; row: unknown[]; columnIndex?: number } | null>(null)
  // Row indices INTO sortedRows (the order currently on screen), not the
  // original query order — copy/export follow whatever the user is looking
  // at. Reset below whenever the active result or the sort changes: after a
  // re-sort the same index would otherwise silently point at a different row.
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set())
  useEffect(() => {
    void fetchLinks().catch(() => undefined)
  }, [fetchLinks])

  useEffect(() => {
    setSortState(null)
  }, [activeResultId])

  useEffect(() => {
    setSelectedRows(new Set())
  }, [activeResultId, sortState])

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

  const exportColumns = useMemo<ExportColumn[]>(() => {
    if (!activeExecuteResult) return []
    return activeExecuteResult.columns.map((name, i) => ({ name, type: activeExecuteResult.column_types?.[i] }))
  }, [activeExecuteResult])

  const copyText = async (text: string, successMessage: string) => {
    const copied = await writeClipboardText(text)
    if (copied) {
      pushToast({ tone: 'success', title: 'Copied', message: successMessage })
    } else {
      pushToast({ tone: 'error', title: 'Copy failed', message: clipboardFailureMessage() })
    }
  }

  const handleCopyCell = (value: unknown) => void copyText(copySingleCellText(value), 'Cell copied to clipboard.')
  const handleCopyRow = (row: unknown[], format: 'tsv' | 'json') =>
    void copyText(
      format === 'tsv' ? buildTSV(exportColumns, [row]) : buildJSON(exportColumns, [row]),
      'Row copied to clipboard.'
    )

  const handleCopy = (format: 'tsv' | 'json', scope: 'all' | 'selected') => {
    const rows = scope === 'all' ? sortedRows : sortedRows.filter((_, index) => selectedRows.has(index))
    const text = format === 'tsv' ? buildTSV(exportColumns, rows) : buildJSON(exportColumns, rows)
    void copyText(text, `${rows.length} row${rows.length === 1 ? '' : 's'} copied to clipboard.`)
  }

  const handleExport = (format: 'csv' | 'json') => {
    const stamp = timestampForFilename()
    const content = format === 'csv' ? buildCSV(exportColumns, sortedRows) : buildJSON(exportColumns, sortedRows)
    const mime = format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8'
    downloadTextFile(`query-result-${stamp}.${format}`, mime, content)
    pushToast({
      tone: 'success',
      title: 'Exported',
      message: `${sortedRows.length} row${sortedRows.length === 1 ? '' : 's'} exported as ${format.toUpperCase()}.`,
    })
  }

  const allSelected = sortedRows.length > 0 && selectedRows.size === sortedRows.length
  const someSelected = selectedRows.size > 0 && !allSelected

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
      <div className="flex min-h-[38px] items-center justify-between gap-2 overflow-x-auto border-b border-border bg-muted/20">
        <div className="flex min-h-[38px] items-center overflow-x-auto">
          {results.map((result) => (
            <SqlResultTab
              key={result.id}
              item={result}
              active={result.id === activeResult?.id}
              onClick={() => onSelectResult(result.id)}
            />
          ))}
        </div>
        {activeExecuteResult && (activeExecuteResult.columns?.length ?? 0) > 0 && (
          <div className="shrink-0 px-2">
            <TableExportMenu
              totalRowCount={sortedRows.length}
              selectedRowCount={selectedRows.size}
              onCopy={handleCopy}
              onExport={handleExport}
            />
          </div>
        )}
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
        ) : activeResult.result.canceled ? (
          <div className="m-3 rounded-sm border border-border bg-muted/20 p-4">
            <div className="flex items-center gap-2 font-mono text-sm text-muted-foreground">
              <Ban className="h-4 w-4" />
              {activeResult.batchScope ? 'Batch canceled' : `Statement ${activeResult.statementIndex + 1} canceled`}
            </div>
            {activeResult.batchScope ? (
              // Statements in a batch run autocommitted, one after another, so a
              // cancel part-way through leaves the earlier ones applied. Saying
              // "statement 1 was canceled" here — which is what this used to
              // say — pointed at the one statement that had almost certainly
              // finished, and hid the rest.
              <p className="mt-2 text-xs text-muted-foreground">
                Statements in a batch are committed one by one, so any that finished before the cancel have already
                been applied. The per-statement record did not survive the cancel — open History to see exactly which
                statements ran.
              </p>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">
                Stopped before it returned a result. If it had already committed on the server at the moment of
                cancel, that write persists — check History to confirm what ran.
              </p>
            )}
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
                  <th className="w-9 border-b border-r border-border px-2 py-2">
                    <div className="flex items-center justify-center">
                      <TableCheckbox
                        checked={allSelected}
                        indeterminate={someSelected}
                        onChange={(checked) =>
                          setSelectedRows(checked ? new Set(sortedRows.map((_, i) => i)) : new Set())
                        }
                      />
                    </div>
                  </th>
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
                  <tr key={`${activeResult.id}-${rowIndex}`} className="odd:bg-muted/10">
                    <td className="border-b border-r border-border/70 px-2 py-2 align-top">
                      <div className="flex items-center justify-center">
                        <TableCheckbox
                          checked={selectedRows.has(rowIndex)}
                          onChange={(checked) =>
                            setSelectedRows((prev) => {
                              const next = new Set(prev)
                              if (checked) next.add(rowIndex)
                              else next.delete(rowIndex)
                              return next
                            })
                          }
                        />
                      </div>
                    </td>
                    {row.map((value, columnIndex) => (
                      <td
                        key={`${activeResult.id}-${rowIndex}-${columnIndex}`}
                        className="max-w-[320px] border-b border-r border-border/70 px-3 py-2 align-top font-mono text-[12px] text-foreground"
                        onContextMenu={(event: MouseEvent) => {
                          event.preventDefault()
                          setRowMenu({ x: event.clientX, y: event.clientY, row, columnIndex })
                        }}
                      >
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
                <FloatingMenuLabel>Copy</FloatingMenuLabel>
                {rowMenu.columnIndex !== undefined && (
                  <FloatingMenuItem
                    onClick={() => {
                      handleCopyCell(rowMenu.row[rowMenu.columnIndex!])
                      setRowMenu(null)
                    }}
                  >
                    Copy cell
                  </FloatingMenuItem>
                )}
                <FloatingMenuItem
                  onClick={() => {
                    handleCopyRow(rowMenu.row, 'tsv')
                    setRowMenu(null)
                  }}
                >
                  Copy row (TSV)
                </FloatingMenuItem>
                <FloatingMenuItem
                  onClick={() => {
                    handleCopyRow(rowMenu.row, 'json')
                    setRowMenu(null)
                  }}
                >
                  Copy row (JSON)
                </FloatingMenuItem>
                <FloatingMenuSeparator />
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
        ) : activeResult.result.row_returning ? (
          <div className="m-3 rounded-sm border border-border bg-muted/20 p-4">
            <div className="flex items-center gap-2 font-mono text-sm text-foreground">
              <Rows3 className="h-4 w-4 text-amber-500" />
              Statement {activeResult.statementIndex + 1} returned {activeResult.result.rows_returned} row{activeResult.result.rows_returned === 1 ? '' : 's'} with no columns
            </div>
            <p className="mt-2 font-mono text-xs text-muted-foreground">
              The SELECT list is empty, so PostgreSQL returned rows without any columns. Did you mean SELECT * or specific columns?
            </p>
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
