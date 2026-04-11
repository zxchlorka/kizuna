import { Database, Folder, KeyRound, type LucideIcon } from 'lucide-react'
import { useConnectionStore } from '@/stores/connections'
import { cn } from '@/lib/utils'
import { getObjectTypeLabel } from '@/lib/objectTypes'
import type { ObjectType } from '@/types/api'

interface RedisKeyViewProps {
  connId: string
  object: string
  objectType: ObjectType
}

function metaCard(label: string, value: string, icon: LucideIcon, accentClass: string) {
  const Icon = icon

  return (
    <div className="rounded-sm border border-border bg-muted/10 px-3 py-3">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
        <Icon className={cn('h-3.5 w-3.5', accentClass)} />
        {label}
      </div>
      <div className="mt-2 font-mono text-sm text-foreground">{value}</div>
    </div>
  )
}

export function RedisKeyView({ connId, object, objectType }: RedisKeyViewProps) {
  const connection = useConnectionStore((state) => state.connections.find((item) => item.id === connId))

  return (
    <div className="flex flex-1 items-center justify-center overflow-auto p-6">
      <div className="w-full max-w-2xl rounded-sm border border-border bg-card p-6 shadow-sm">
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-sm border border-red-500/20 bg-red-500/5">
            <KeyRound className="h-5 w-5 text-red-500" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              Redis key preview
            </p>
            <h2 className="mt-1 truncate font-mono text-lg font-semibold text-foreground">{object}</h2>
            <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
              Full Redis value editing is not wired yet. This tab keeps the navigation path intact and confirms the tree can open typed Redis keys without falling back to PostgreSQL views.
            </p>
          </div>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          {metaCard('Type', getObjectTypeLabel(objectType), Database, 'text-red-500')}
          {metaCard('Connection', connection?.name ?? connId, Folder, 'text-amber-500')}
          {metaCard('Mode', connection?.mode ?? 'standalone', Database, 'text-blue-500')}
        </div>
      </div>
    </div>
  )
}
