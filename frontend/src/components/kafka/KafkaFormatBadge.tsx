import { cn } from '@/lib/utils'

const formatStyles: Record<string, string> = {
  json: 'border-emerald-500/20 bg-emerald-500/5 text-emerald-500',
  text: 'border-sky-500/20 bg-sky-500/5 text-sky-500',
  binary: 'border-amber-500/20 bg-amber-500/5 text-amber-500',
  empty: 'border-border bg-muted/20 text-muted-foreground',
}

export function KafkaFormatBadge({ format }: { format: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-sm border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em]',
        formatStyles[format] ?? formatStyles.empty
      )}
    >
      {format || 'unknown'}
    </span>
  )
}
