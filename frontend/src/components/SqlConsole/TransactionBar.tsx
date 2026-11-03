import { AlertTriangle, Check, GitCommitHorizontal, Undo2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { TxState } from '@/types/api'

interface TransactionBarProps {
  transaction: TxState
  running: boolean
  onCommit: () => void
  onRollback: () => void
  onDismiss: () => void
}

// Shown while the console's server session is not idle. An open transaction is
// otherwise invisible: every statement in it reports success, and nothing is
// applied until COMMIT.
export function TransactionBar({ transaction, running, onCommit, onRollback, onDismiss }: TransactionBarProps) {
  if (transaction === 'idle') return null

  const failed = transaction !== 'open'
  return (
    <div
      role="status"
      className={cn(
        'flex flex-wrap items-center justify-between gap-2 border-b px-3 py-1.5 text-xs',
        failed
          ? 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300'
          : 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {failed ? <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> : <GitCommitHorizontal className="h-3.5 w-3.5 shrink-0" />}
        <span className="font-medium">
          {transaction === 'open' && 'Transaction open'}
          {transaction === 'failed' && 'Transaction failed'}
          {transaction === 'lost' && 'Transaction rolled back'}
        </span>
        <span className="truncate opacity-80">
          {transaction === 'open' && 'Changes are visible only in this console until you commit.'}
          {transaction === 'failed' && 'A statement failed, so nothing more runs in it. Roll back to continue.'}
          {transaction === 'lost' && 'The connection dropped while it was open, so the server undid everything in it.'}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        {transaction === 'open' && (
          <Button type="button" size="sm" className="h-7 gap-1.5 font-mono text-[11px]" disabled={running} onClick={onCommit}>
            <Check className="h-3.5 w-3.5" />
            Commit
          </Button>
        )}
        {transaction !== 'lost' && (
          <Button type="button" size="sm" variant="outline" className="h-7 gap-1.5 font-mono text-[11px]" disabled={running} onClick={onRollback}>
            <Undo2 className="h-3.5 w-3.5" />
            Rollback
          </Button>
        )}
        {transaction === 'lost' && (
          <button type="button" aria-label="Dismiss" className="rounded-sm p-1 hover:bg-red-500/10" onClick={onDismiss}>
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}
