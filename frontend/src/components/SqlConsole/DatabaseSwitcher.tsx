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

interface DatabaseSwitcherProps {
  connId: string
  tabId: string
  connectionLabel: string
}

interface DatabasesResponse {
  current: string
  databases: string[]
}

export function DatabaseSwitcher({ connId, tabId, connectionLabel }: DatabaseSwitcherProps) {
  const pushToast = useToastStore((state) => state.push)
  const connection = useConnectionStore((state) => state.connections.find((item) => item.id === connId))
  const [databases, setDatabases] = useState<DatabasesResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [switching, setSwitching] = useState<string | null>(null)

  const isPostgres = connection?.type === 'postgres'

  const loadDatabases = async () => {
    setLoading(true)
    try {
      const res = await fetchWithTimeout(`/api/connections/${connId}/databases`)
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
    if (!databases || database === databases.current || switching) {
      return
    }
    setSwitching(database)
    try {
      const res = await fetchWithTimeout(`/api/connections/${connId}/duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ database }),
      })
      const body = await res.json()
      if (!res.ok) {
        throw new Error(body.error || 'Failed to switch database')
      }
      const siblingId: string = body.id

      await useConnectionStore.getState().fetch()

      // Re-point this console tab at the sibling database in place: the tab
      // (and its editor text) stays on the current page, only the query
      // target changes.
      useWorkspaceStore.getState().rebindSqlTab(tabId, siblingId)
    } catch (error) {
      pushToast({ tone: 'error', title: 'Switch failed', message: (error as Error).message })
    } finally {
      setSwitching(null)
    }
  }

  if (!isPostgres) {
    return (
      <div className="rounded-sm border border-border bg-muted/30 px-2.5 py-1 font-mono text-[11px] text-muted-foreground">
        {connectionLabel}
      </div>
    )
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
          className="flex items-center gap-1.5 rounded-sm border border-border bg-muted/30 px-2.5 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:border-amber-500/30 hover:text-foreground"
        >
          <Database className="h-3 w-3" />
          {connectionLabel}
          <ChevronDown className="h-3 w-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
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
            const isCurrent = database === databases.current
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
