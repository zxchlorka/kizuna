import { Lightbulb } from 'lucide-react'
import type { CompletionItem } from '@/types/api'

interface RedisCommandHelperProps {
  item: CompletionItem | null
}

export function RedisCommandHelper({ item }: RedisCommandHelperProps) {
  if (!item) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-dashed border-border bg-muted/20 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
        <Lightbulb className="h-3.5 w-3.5 opacity-60" />
        Start typing a command to see its syntax.
      </div>
    )
  }

  // detail is "SYNTAX — Description"; split so the syntax pops in accent.
  const [syntax, ...rest] = (item.detail ?? '').split(' — ')
  const description = rest.join(' — ')

  return (
    <div className="flex items-start gap-2 rounded-md border border-accent/25 bg-accent/[0.06] px-3 py-1.5">
      <Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
      <div className="min-w-0 font-mono text-[11px] leading-relaxed">
        <span className="font-semibold text-accent">{syntax || item.label}</span>
        {description ? <span className="text-muted-foreground"> — {description}</span> : null}
      </div>
    </div>
  )
}
