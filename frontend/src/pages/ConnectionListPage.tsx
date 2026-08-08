import { useEffect, useMemo, useState } from 'react'
import { useTheme } from 'next-themes'
import { Plus, Sun, Moon, Settings } from 'lucide-react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ConnectionTypeTabs, type ConnectionTypeFilter } from '@/components/ConnectionTypeTabs'
import { deleteConnectionEverywhere } from '@/lib/connectionDeletion'
import { cn } from '@/lib/utils'
import { useConnectionStore } from '@/stores/connections'
import { ConnectionCard } from '@/components/ConnectionCard'
import { ConnectionWizard } from '@/components/ConnectionWizard'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import type { Connection } from '@/types/api'
import { HEALTH_POLL_MS, useConnectionHealthStore } from '@/stores/connectionHealth'

export default function ConnectionListPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { resolvedTheme, setTheme } = useTheme()
  const { connections, loading, loadedOnce, error, fetch: fetchConnections } = useConnectionStore()
  const hydrateHealth = useConnectionHealthStore((state) => state.hydrate)
  const pruneHealth = useConnectionHealthStore((state) => state.prune)
  const refreshStaleHealth = useConnectionHealthStore((state) => state.refreshStale)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [editingConnection, setEditingConnection] = useState<Connection | undefined>(undefined)
  const [mounted, setMounted] = useState(false)
  const searchType = searchParams.get('type')
  const selectedType: ConnectionTypeFilter =
    searchType === 'postgres' || searchType === 'redis' || searchType === 'kafka' ? searchType : 'all'

  const counts = {
    all: connections.length,
    postgres: connections.filter((connection) => connection.type === 'postgres').length,
    redis: connections.filter((connection) => connection.type === 'redis').length,
    kafka: connections.filter((connection) => connection.type === 'kafka').length,
  }

  const visibleConnections =
    selectedType === 'all'
      ? connections
      : connections.filter((connection) => connection.type === selectedType)

  useEffect(() => {
    hydrateHealth()
    setMounted(true)
  }, [hydrateHealth])

  useEffect(() => {
    if (connections.length > 0 || loading || loadedOnce || error) {
      return
    }
    void fetchConnections()
  }, [connections.length, error, fetchConnections, loadedOnce, loading])

  // Stable across re-renders so the poll below is not torn down and restarted
  // every time this component renders for an unrelated reason.
  const connectionIds = useMemo(() => connections.map((connection) => connection.id), [connections])

  // Pruning is gated on the fetch having actually succeeded, not merely having
  // finished: the store sets loadedOnce on its error path too (see
  // stores/connections.ts), leaving connections at []. Without this, one
  // unreachable backend would drop the whole health cache — and since prune
  // persists, drop it from localStorage as well. The store refuses an empty list
  // on its own, so this is the second half of the same guard, placed here
  // because only the caller knows whether the list is trustworthy.
  useEffect(() => {
    if (!loadedOnce || error || connectionIds.length === 0) {
      return
    }
    pruneHealth(connectionIds)
    void refreshStaleHealth(connectionIds)
  }, [connectionIds, error, loadedOnce, pruneHealth, refreshStaleHealth])

  // Health only re-checks itself while this screen is open and its tab is in the
  // foreground. Without the tick, a status had exactly one chance to be right --
  // the moment the list mounted -- so a server that came back (VPN reconnected,
  // datasource restarted) stayed red until the user pressed test by hand.
  //
  // Scoped rather than global on purpose: dialing every datasource on a minute's
  // schedule while the user is working inside one database is load nobody asked
  // for. The tick is also TTL-gated by refreshStale, so a burst of remounts or a
  // tab regaining focus cannot turn into a burst of connection tests.
  useEffect(() => {
    if (!loadedOnce || error || connectionIds.length === 0) {
      return
    }

    let timer: number | undefined
    const tick = () => {
      if (document.hidden) {
        return
      }
      void refreshStaleHealth(connectionIds)
    }
    const start = () => {
      window.clearInterval(timer)
      timer = window.setInterval(tick, HEALTH_POLL_MS)
    }
    const onVisibilityChange = () => {
      if (document.hidden) {
        // Stop the timer outright instead of letting it fire into a hidden tab:
        // browsers throttle background intervals unpredictably, and a resumed
        // tab should re-check immediately rather than wait out a stale phase.
        window.clearInterval(timer)
        return
      }
      tick()
      start()
    }

    start()
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [connectionIds, error, loadedOnce, refreshStaleHealth])

  const openCreate = () => {
    setEditingConnection(undefined)
    setWizardOpen(true)
  }

  const openEdit = (conn: Connection) => {
    setEditingConnection(conn)
    setWizardOpen(true)
  }

  const handleWizardClose = (open: boolean) => {
    setWizardOpen(open)
    if (!open) {
      setEditingConnection(undefined)
    }
  }

  const handleTypeChange = (value: ConnectionTypeFilter) => {
    const nextParams = new URLSearchParams(searchParams)
    if (value === 'all') {
      nextParams.delete('type')
    } else {
      nextParams.set('type', value)
    }
    setSearchParams(nextParams, { replace: true })
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b border-border/60 bg-background/90 backdrop-blur-md">
        <div className="flex h-14 items-center justify-between px-6">
          <div className="flex items-center gap-2.5 animate-fade-in-up" style={{ animationDelay: '0ms', animationFillMode: 'both' }}>
            <span className="select-none text-[26px] leading-none text-amber-500">絆</span>
            <span className="select-none font-sans text-[22px] font-medium lowercase leading-none tracking-[-0.01em]">kizuna</span>
          </div>

          <div className="flex items-center gap-2 animate-fade-in-up" style={{ animationDelay: '80ms', animationFillMode: 'both' }}>
            <button
              onClick={() => navigate('/settings')}
              className={cn(
                'group relative flex h-8 w-8 items-center justify-center rounded-sm',
                'border border-border text-muted-foreground',
                'transition-all duration-200 hover:border-amber-500/50 hover:text-amber-500'
              )}
              title="Settings"
            >
              <div className="absolute inset-0 rounded-sm bg-amber-500/0 transition-colors duration-200 group-hover:bg-amber-500/5" />
              <Settings className="relative z-10 h-3.5 w-3.5 transition-transform duration-300 group-hover:rotate-12" />
            </button>
            {mounted && (
              <button
                onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
                className={cn(
                  'group relative flex h-8 w-8 items-center justify-center rounded-sm',
                  'border border-border text-muted-foreground',
                  'transition-all duration-200 hover:border-amber-500/50 hover:text-amber-500'
                )}
                title="Toggle theme"
              >
                <div className="absolute inset-0 rounded-sm bg-amber-500/0 transition-colors duration-200 group-hover:bg-amber-500/5" />
                {resolvedTheme === 'dark' ? (
                  <Sun className="relative z-10 h-3.5 w-3.5 transition-transform duration-300 group-hover:rotate-45" />
                ) : (
                  <Moon className="relative z-10 h-3.5 w-3.5 transition-transform duration-300 group-hover:-rotate-12" />
                )}
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">
        {loading && <LoadingSkeleton variant="connections" />}

        {error && <ErrorBanner message={error} onRetry={() => void fetchConnections()} />}

        {!loading && !error && connections.length === 0 && (
          <div className="animate-fade-in-up py-16" style={{ animationFillMode: 'both' }}>
            <EmptyState variant="no_connections" actionLabel="New Connection" onAction={openCreate} />
          </div>
        )}

        {!loading && connections.length > 0 && (
          <>
            <div
              className="mb-6 flex flex-col gap-4 animate-fade-in-up md:flex-row md:items-end md:justify-between"
              style={{ animationDelay: '40ms', animationFillMode: 'both' }}
            >
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-mono uppercase tracking-[0.15em] text-muted-foreground">
                    Connections
                  </span>
                  <span className="rounded-sm border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-muted-foreground">
                    {visibleConnections.length}
                  </span>
                </div>
                <ConnectionTypeTabs value={selectedType} counts={counts} onChange={handleTypeChange} />
              </div>

              <button
                onClick={openCreate}
                className={cn(
                  'group flex items-center gap-1.5 self-start rounded-sm border border-amber-500/40 bg-amber-500/8 px-3 py-1.5 font-mono text-xs font-medium text-amber-500',
                  'transition-all duration-200 hover:border-amber-500/70 hover:bg-amber-500/15 md:self-auto'
                )}
              >
                <Plus className="h-3 w-3 transition-transform duration-200 group-hover:rotate-90" />
                New
              </button>
            </div>

            {visibleConnections.length === 0 ? (
              <div className="animate-fade-in-up py-10" style={{ animationDelay: '80ms', animationFillMode: 'both' }}>
                <EmptyState
                  variant="no_results"
                  title={`No ${selectedType} connections`}
                  description={`There are no ${selectedType} connections in this workspace yet. Switch back to all connections or create a new one.`}
                  actionLabel={selectedType === 'all' ? 'New Connection' : 'Show All'}
                  onAction={selectedType === 'all' ? openCreate : () => handleTypeChange('all')}
                />
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {visibleConnections.map((conn, i) => (
                  <div
                    key={conn.id}
                    className="animate-fade-in-up"
                    style={{ animationDelay: `${80 + i * 55}ms`, animationFillMode: 'both' }}
                  >
                    <ConnectionCard connection={conn} onDelete={deleteConnectionEverywhere} onEdit={openEdit} />
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </main>

      <ConnectionWizard open={wizardOpen} onOpenChange={handleWizardClose} editConnection={editingConnection} />
    </div>
  )
}
