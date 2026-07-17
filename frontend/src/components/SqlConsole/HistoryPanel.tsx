import { Search, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/EmptyState'
import { HistoryEntry } from '@/components/SqlConsole/HistoryEntry'
import type { HistoryEntry as HistoryEntryType } from '@/types/api'

interface HistoryPanelProps {
  open: boolean
  loading: boolean
  search: string
  items: HistoryEntryType[]
  onSearchChange: (value: string) => void
  onClose: () => void
  onClear: () => void
  onInsert: (command: string) => void
  onExecute: (command: string) => void
}

export function HistoryPanel({
  open,
  loading,
  search,
  items,
  onSearchChange,
  onClose,
  onClear,
  onInsert,
  onExecute,
}: HistoryPanelProps) {
  if (!open) {
    return null
  }

  return (
    <div className="absolute inset-y-0 right-0 z-20 w-full max-w-sm border-l border-border bg-background shadow-2xl">
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <div>
            <p className="font-mono text-xs text-foreground">Query History</p>
            <p className="text-[11px] text-muted-foreground">Click to insert, double-click to run</p>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="border-b border-border px-3 py-2">
          <div className="flex items-center gap-2 rounded-sm border border-border bg-background px-2">
            <Search className="h-3.5 w-3.5 text-muted-foreground" />
            <input
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="Search commands"
              className="h-8 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <Button type="button" size="sm" variant="ghost" className="mt-2 h-8 gap-1.5 font-mono text-[11px]" onClick={onClear}>
            <Trash2 className="h-3.5 w-3.5" />
            Clear history
          </Button>
        </div>

        <div className="flex-1 overflow-auto p-3">
          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 6 }).map((_, index) => (
                <div key={index} className="h-16 animate-pulse rounded-sm border border-border bg-muted/30" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              variant="no_results"
              compact
              title="No history yet"
              description="Executed statements will appear here."
            />
          ) : (
            <div className="space-y-2">
              {items.map((entry) => (
                <HistoryEntry
                  key={entry.id}
                  entry={entry}
                  onClick={() => onInsert(entry.command)}
                  onDoubleClick={() => onExecute(entry.command)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
