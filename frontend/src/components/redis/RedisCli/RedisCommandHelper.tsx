import { HelpCircle } from 'lucide-react'
import type { CompletionItem } from '@/types/api'

interface RedisCommandHelperProps {
  item: CompletionItem | null
}

export function RedisCommandHelper({ item }: RedisCommandHelperProps) {
  if (!item) {
    return (
      <div className="rounded-sm border border-border/70 bg-background/50 px-3 py-2 text-xs text-muted-foreground">
        Start typing a Redis command to see syntax help.
      </div>
    )
  }

  return (
    <div className="rounded-sm border border-cyan-500/20 bg-cyan-500/5 px-3 py-2 text-xs">
      <div className="flex items-center gap-2 text-cyan-700 dark:text-cyan-300">
        <HelpCircle className="h-3.5 w-3.5" />
        <span className="font-mono">{item.label}</span>
      </div>
      <div className="mt-1 font-mono text-muted-foreground">{item.detail}</div>
    </div>
  )
}
