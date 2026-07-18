import { useState } from 'react'
import { Check, ChevronDown, Database, Loader2 } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { fetchWithTimeout } from '@/lib/http'
import { useConnectionStore } from '@/stores/connections'
import { useToastStore } from '@/stores/toast'
import { useWorkspaceStore } from '@/stores/workspace'

interface TreeDatabaseSwitcherProps {
  pageConnId: string
  viewConnId: string
}

interface DatabasesResponse {
  current: string
  databases: string[]
}

// Switches which database the object tree displays, without leaving the page:
// sibling connections are created (idempotently) on the backend and the tree
// is re-pointed at them via the workspace treeConnByPage override.
export function TreeDatabaseSwitcher({ pageConnId, viewConnId }: TreeDatabaseSwitcherProps) {
  const pushToast = useToastStore((state) => state.push)
  const setTreeConn = useWorkspaceStore((state) => state.setTreeConn)
  const pageConnection = useConnectionStore((state) => state.connections.find((item) => item.id === pageConnId))
  const viewConnection = useConnectionStore((state) => state.connections.find((item) => item.id === viewConnId))
  const [databases, setDatabases] = useState<DatabasesResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [switching, setSwitching] = useState<string | null>(null)

  const currentDatabase = viewConnection?.database ?? ''

  const loadDatabases = async () => {
    setLoading(true)
    try {
      const res = await fetchWithTimeout(`/api/connections/${pageConnId}/databases`)
      const body = await res.json()
      if (!res.ok) {
        throw new Error(body.error || 'Failed to list databases')
      }
      setDatabases(body as DatabasesResponse)
    } catch (error) {
      setDatabases(null)
      pushToast({ tone: 'error', title: 'Databases unavailable', message: (error as Error).message })
    } finally {
      setLoading(false)
    }
  }

  const handleSwitch = async (database: string) => {
    if (database === currentDatabase || switching) {
      return
    }
    setSwitching(database)
    try {
      if (database === pageConnection?.database) {
        setTreeConn(pageConnId, pageConnId)
        return
      }
      const res = await fetchWithTimeout(`/api/connections/${pageConnId}/duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ database }),
      })
      const body = await res.json()
      if (!res.ok) {
        throw new Error(body.error || 'Failed to switch database')
      }
      await useConnectionStore.getState().fetch()
      setTreeConn(pageConnId, body.id as string)
    } catch (error) {
      pushToast({ tone: 'error', title: 'Switch failed', message: (error as Error).message })
    } finally {
      setSwitching(null)
    }
  }

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open && !databases && !loading) {
          void loadDatabases()
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="mb-2 flex w-full items-center gap-1.5 rounded-sm border border-border bg-muted/10 px-2 py-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:border-amber-500/30 hover:text-foreground"
          title="Switch which database the tree shows"
        >
          <Database className="h-3 w-3 shrink-0 text-amber-500" />
          <span className="min-w-0 flex-1 truncate text-left">{currentDatabase || 'database'}</span>
          <ChevronDown className="h-3 w-3 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        <DropdownMenuLabel className="font-mono text-[11px] text-muted-foreground">
          Databases on this server
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {loading ? (
          <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading databases
          </div>
        ) : !databases ? (
          <div className="px-2 py-2 text-xs text-muted-foreground">No databases found.</div>
        ) : (
          databases.databases.map((database) => {
            const isCurrent = database === currentDatabase
            return (
              <DropdownMenuItem
                key={database}
                disabled={isCurrent || switching !== null}
                onSelect={() => void handleSwitch(database)}
                className="gap-2 font-mono text-xs"
              >
                {switching === database ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className={isCurrent ? 'h-3.5 w-3.5 text-amber-500' : 'h-3.5 w-3.5 opacity-0'} />
                )}
                {database}
              </DropdownMenuItem>
            )
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
