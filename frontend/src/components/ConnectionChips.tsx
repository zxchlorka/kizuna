import { useNavigate } from 'react-router-dom'
import { Plus, X } from 'lucide-react'
import { ConnectionTypeIcon } from '@/components/ConnectionTypeIcon'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { useConnectionStore } from '@/stores/connections'
import { useWorkspaceStore } from '@/stores/workspace'

interface ConnectionChipsProps {
  activeId: string
}

export function ConnectionChips({ activeId }: ConnectionChipsProps) {
  const navigate = useNavigate()
  const connections = useConnectionStore((state) => state.connections)
  const openConnectionIds = useWorkspaceStore((state) => state.openConnectionIds)
  const closeConnection = useWorkspaceStore((state) => state.closeConnection)

  // Only render chips for connections that still exist (a deleted connection's
  // chip silently drops out).
  const chips = openConnectionIds
    .map((id) => connections.find((connection) => connection.id === id))
    .filter((connection): connection is NonNullable<typeof connection> => Boolean(connection))

  const handleClose = (id: string) => {
    closeConnection(id)
    if (id !== activeId) {
      return
    }
    const remaining = openConnectionIds.filter((openId) => openId !== id)
    if (remaining.length > 0) {
      navigate(`/connections/${remaining[remaining.length - 1]}`)
    } else {
      navigate('/')
    }
  }

  const unopened = connections.filter((connection) => !openConnectionIds.includes(connection.id))

  return (
    <div className="flex items-center gap-1 border-b border-border bg-muted/10 px-2 py-1">
      <div className="flex flex-1 items-center gap-1 overflow-x-auto">
        {chips.map((connection) => {
          const isActive = connection.id === activeId
          return (
            <div
              key={connection.id}
              className={cn(
                'group flex shrink-0 items-center gap-1.5 rounded-sm border px-2 py-1 font-mono text-xs',
                isActive
                  ? 'border-accent/40 bg-accent/10 text-foreground'
                  : 'border-border bg-background text-muted-foreground hover:text-foreground'
              )}
            >
              <button
                type="button"
                className="flex items-center gap-1.5"
                onClick={() => navigate(`/connections/${connection.id}`)}
              >
                <ConnectionTypeIcon type={connection.type} className="h-3.5 w-3.5" />
                <span className="max-w-40 truncate">{connection.name}</span>
              </button>
              <button
                type="button"
                aria-label={`Close ${connection.name}`}
                className="rounded-sm p-0.5 text-muted-foreground opacity-60 hover:bg-muted hover:text-destructive group-hover:opacity-100"
                onClick={() => handleClose(connection.id)}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )
        })}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Open another connection"
            className="flex shrink-0 items-center gap-1 rounded-sm border border-border bg-background px-2 py-1 font-mono text-xs text-muted-foreground hover:text-foreground"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-80 overflow-auto">
          {unopened.length === 0 ? (
            <DropdownMenuItem disabled>All connections open</DropdownMenuItem>
          ) : (
            unopened.map((connection) => (
              <DropdownMenuItem
                key={connection.id}
                onClick={() => navigate(`/connections/${connection.id}`)}
                className="gap-2 font-mono text-xs"
              >
                <ConnectionTypeIcon type={connection.type} className="h-3.5 w-3.5" />
                {connection.name}
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
