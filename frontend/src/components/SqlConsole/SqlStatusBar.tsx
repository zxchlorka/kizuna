import type { SqlResultItem } from '@/stores/sqlConsole'

interface SqlStatusBarProps {
  activeResult: SqlResultItem | null
  totalResults: number
}

export function SqlStatusBar({ activeResult, totalResults }: SqlStatusBarProps) {
  if (!activeResult) {
    return (
      <div className="flex items-center justify-between border-t border-border bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
        <span>Ready</span>
        <span>No statements executed</span>
      </div>
    )
  }

  if (activeResult.kind === 'explain') {
    const modeLabel = activeResult.result.mode === 'analyze' ? 'Analyze' : 'Explain'
    return (
      <div className="flex items-center justify-between border-t border-border bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
        <span>{modeLabel} plan ready</span>
        <span>{activeResult.result.duration_ms}ms · Stmt {activeResult.statementIndex + 1}/{totalResults}</span>
      </div>
    )
  }

  const { result } = activeResult
  const left = result.error
    ? 'Execution failed'
    : result.truncated
      ? `Showing first ${result.applied_limit ?? result.rows_returned} rows`
    : result.row_returning || result.rows_returned > 0
      ? `${result.rows_returned} row${result.rows_returned === 1 ? '' : 's'}`
      : `${result.rows_affected} row${result.rows_affected === 1 ? '' : 's'} affected`

  return (
    <div className="flex items-center justify-between border-t border-border bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
      <span>{left}</span>
      <span>{result.duration_ms}ms · Stmt {activeResult.statementIndex + 1}/{totalResults}</span>
    </div>
  )
}
