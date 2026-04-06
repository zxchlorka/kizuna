import { AlertTriangle, Rows3, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SqlResultItem } from '@/stores/sqlConsole'

interface SqlResultTabProps {
  item: SqlResultItem
  active: boolean
  onClick: () => void
}

export function SqlResultTab({ item, active, onClick }: SqlResultTabProps) {
  const isError = item.kind === 'execute' && Boolean(item.result.error)

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 border-r border-border px-3 py-2 text-xs transition-colors',
        active ? 'bg-background text-foreground' : 'bg-muted/20 text-muted-foreground hover:bg-muted/40 hover:text-foreground'
      )}
    >
      {isError ? (
        <AlertTriangle className="h-3.5 w-3.5 text-red-500" />
      ) : item.kind === 'explain' ? (
        <Sparkles className="h-3.5 w-3.5 text-amber-500" />
      ) : (
        <Rows3 className="h-3.5 w-3.5 text-emerald-500" />
      )}
      <span className="font-mono">{item.label}</span>
    </button>
  )
}
