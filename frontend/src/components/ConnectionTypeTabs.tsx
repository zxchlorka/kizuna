import { ConnectionTypeIcon } from '@/components/ConnectionTypeIcon'
import { cn } from '@/lib/utils'
import type { ConnectionType } from '@/types/api'

export type ConnectionTypeFilter = 'all' | ConnectionType

interface ConnectionTypeTabsProps {
  value: ConnectionTypeFilter
  counts: Record<ConnectionTypeFilter, number>
  onChange: (value: ConnectionTypeFilter) => void
}

const filterOptions: Array<{
  value: ConnectionTypeFilter
  label: string
  tone: string
}> = [
  { value: 'all', label: 'All', tone: 'text-foreground' },
  { value: 'postgres', label: 'Postgres', tone: 'text-blue-400' },
  { value: 'redis', label: 'Redis', tone: 'text-red-400' },
  { value: 'kafka', label: 'Kafka', tone: 'text-orange-400' },
]

export function ConnectionTypeTabs({ value, counts, onChange }: ConnectionTypeTabsProps) {
  return (
    <div className="space-y-2">
      <p className="text-[10px] font-mono uppercase tracking-[0.15em] text-muted-foreground">View</p>
      <div
        role="tablist"
        aria-label="Connection type filter"
        className="inline-flex flex-wrap items-center gap-2 rounded-sm border border-border/80 bg-card/60 p-1"
      >
        {filterOptions.map((option) => {
          const active = option.value === value

          return (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onChange(option.value)}
              className={cn(
                'group inline-flex min-w-[8.5rem] items-center justify-between gap-3 rounded-sm border px-3 py-2 text-left transition-all duration-200',
                active
                  ? 'border-amber-500/45 bg-amber-500/10 text-foreground shadow-[inset_0_0_0_1px_rgba(245,158,11,0.08)]'
                  : 'border-transparent bg-transparent text-muted-foreground hover:border-border/80 hover:bg-muted/30 hover:text-foreground'
              )}
            >
              <span className="inline-flex items-center gap-2">
                {option.value === 'all' ? (
                  <span className="flex h-5 w-5 items-center justify-center rounded-sm border border-border/80 bg-background text-[9px] font-mono uppercase tracking-[0.14em] text-muted-foreground">
                    A
                  </span>
                ) : (
                  <span className="flex h-5 w-5 items-center justify-center rounded-sm border border-border/80 bg-background">
                    <ConnectionTypeIcon type={option.value} className="h-3.5 w-3.5" />
                  </span>
                )}
                <span className={cn('font-mono text-[11px] uppercase tracking-[0.14em]', active ? option.tone : 'text-inherit')}>
                  {option.label}
                </span>
              </span>
              <span
                className={cn(
                  'rounded-sm border px-1.5 py-0.5 font-mono text-[10px] tabular-nums',
                  active
                    ? 'border-amber-500/35 bg-background/70 text-foreground'
                    : 'border-border bg-background/70 text-muted-foreground'
                )}
              >
                {counts[option.value]}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
