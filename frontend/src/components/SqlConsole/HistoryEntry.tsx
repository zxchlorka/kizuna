import { AlertTriangle, Check, Clock3 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { HistoryEntry as HistoryEntryType } from '@/types/api'

interface HistoryEntryProps {
  entry: HistoryEntryType
  onClick: () => void
  onDoubleClick: () => void
}

function durationTone(durationMs: number) {
  if (durationMs < 100) {
    return 'text-emerald-600 dark:text-emerald-300'
  }
  if (durationMs < 1000) {
    return 'text-amber-600 dark:text-amber-300'
  }
  return 'text-red-600 dark:text-red-300'
}

export function HistoryEntry({ entry, onClick, onDoubleClick }: HistoryEntryProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className="w-full rounded-sm border border-border bg-background/80 px-3 py-2 text-left transition-colors hover:border-accent hover:bg-muted/20"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-[11px] text-foreground">{entry.command}</p>
          <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
            <Clock3 className="h-3 w-3" />
            <span>{new Date(entry.executed_at).toLocaleString()}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={cn('rounded-sm border border-current/20 px-1.5 py-0.5 font-mono text-[11px]', durationTone(entry.duration_ms))}>
            {entry.duration_ms}ms
          </span>
          {entry.error ? (
            <AlertTriangle className="h-3.5 w-3.5 text-red-500" />
          ) : (
            <Check className="h-3.5 w-3.5 text-emerald-500" />
          )}
        </div>
      </div>
    </button>
  )
}
