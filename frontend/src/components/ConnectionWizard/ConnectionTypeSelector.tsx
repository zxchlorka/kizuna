import { Database, Server } from 'lucide-react'
import { ConnectionTypeIcon } from '@/components/ConnectionTypeIcon'
import { cn } from '@/lib/utils'
import type { ConnectionType } from '@/types/api'

interface ConnectionTypeSelectorProps {
  selectedType: ConnectionType
  onSelectType: (type: ConnectionType) => void
}

const options: Array<{
  type: ConnectionType
  title: string
  description: string
}> = [
  {
    type: 'postgres',
    title: 'PostgreSQL',
    description: 'Relational schema browser with tables, views, and indexes.',
  },
  {
    type: 'redis',
    title: 'Redis',
    description: 'Standalone, cluster, and sentinel connection modes.',
  },
]

export function ConnectionTypeSelector({ selectedType, onSelectType }: ConnectionTypeSelectorProps) {
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">Select connection type</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {options.map((option) => {
          const active = option.type === selectedType

          return (
            <button
              key={option.type}
              type="button"
              onClick={() => onSelectType(option.type)}
              className={cn(
                'group relative flex min-h-36 flex-col items-start justify-between rounded-sm border p-4 text-left transition-colors',
                active
                  ? 'border-amber-500/60 bg-amber-500/5 shadow-[0_0_0_1px_rgba(245,158,11,0.08)]'
                  : 'border-border bg-background hover:border-border/80 hover:bg-muted/30'
              )}
            >
              <div className="space-y-3">
                <div
                  className={cn(
                    'flex h-10 w-10 items-center justify-center rounded-sm border',
                    active ? 'border-amber-500/30 bg-amber-500/10' : 'border-border bg-muted/20'
                  )}
                >
                  <ConnectionTypeIcon type={option.type} className="h-5 w-5" />
                </div>
                <div>
                  <div className="font-mono text-sm font-semibold text-foreground">{option.title}</div>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">{option.description}</p>
                </div>
              </div>
              {option.type === 'redis' && (
                <div className="mt-4 flex items-center gap-2 text-[10px] font-mono uppercase tracking-[0.14em] text-muted-foreground">
                  <Server className="h-3.5 w-3.5 text-red-500" />
                  Mode aware
                </div>
              )}
            </button>
          )
        })}
        <div className="flex min-h-36 flex-col justify-between rounded-sm border border-border bg-background p-4 opacity-50">
          <div className="space-y-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-sm border border-border bg-muted/20">
              <Database className="h-5 w-5 text-orange-400" />
            </div>
            <div>
              <div className="font-mono text-sm font-semibold text-foreground">Kafka</div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">Coming in Phase 3.</p>
            </div>
          </div>
          <div className="mt-4 text-[10px] font-mono uppercase tracking-[0.14em] text-muted-foreground">
            Disabled
          </div>
        </div>
      </div>
    </div>
  )
}
