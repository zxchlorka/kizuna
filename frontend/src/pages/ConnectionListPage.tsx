import { useEffect, useState } from 'react'
import { useTheme } from 'next-themes'
import { Plus, Sun, Moon, Settings } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useConnectionStore } from '@/stores/connections'
import { ConnectionCard } from '@/components/ConnectionCard'
import { ConnectionWizard } from '@/components/ConnectionWizard'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import type { Connection } from '@/types/api'
import { useNavigate } from 'react-router-dom'
import { useConnectionHealthStore } from '@/stores/connectionHealth'

export default function ConnectionListPage() {
  const navigate = useNavigate()
  const { resolvedTheme, setTheme } = useTheme()
  const { connections, loading, loadedOnce, error, fetch: fetchConnections, remove } = useConnectionStore()
  const hydrateHealth = useConnectionHealthStore((state) => state.hydrate)
  const pruneHealth = useConnectionHealthStore((state) => state.prune)
  const refreshStaleHealth = useConnectionHealthStore((state) => state.refreshStale)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [editingConnection, setEditingConnection] = useState<Connection | undefined>(undefined)
  const [mounted, setMounted] = useState(false)

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

  useEffect(() => {
    const connectionIds = connections.map((connection) => connection.id)
    pruneHealth(connectionIds)
    if (connectionIds.length === 0) {
      return
    }
    void refreshStaleHealth(connectionIds)
  }, [connections, pruneHealth, refreshStaleHealth])

  const openCreate = () => { setEditingConnection(undefined); setWizardOpen(true) }
  const openEdit = (conn: Connection) => { setEditingConnection(conn); setWizardOpen(true) }
  const handleWizardClose = (open: boolean) => {
    setWizardOpen(open)
    if (!open) setEditingConnection(undefined)
  }

  return (
    <div className="min-h-screen bg-background">
      {/* ── Header ─────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-50 border-b border-border/60 bg-background/90 backdrop-blur-md">
        <div className="flex items-center justify-between px-6 h-14">

          {/* Logo — LEFT */}
          <div className="flex items-center gap-2.5 animate-fade-in-up" style={{ animationDelay: '0ms', animationFillMode: 'both' }}>
            <div className="relative h-7 w-7 flex items-center justify-center shrink-0">
              <div className="absolute inset-0 rounded-sm border border-amber-500/30 bg-amber-500/5 animate-pulse-slow" />
              {/* Hexagonal grid icon */}
              <svg viewBox="0 0 24 24" className="h-[15px] w-[15px] text-amber-500 relative z-10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5" />
                <polyline points="12 2 12 22" />
                <polyline points="2 8.5 22 8.5" />
                <polyline points="2 15.5 22 15.5" />
              </svg>
            </div>
            <span className="font-bold text-[15px] tracking-tight font-mono select-none">
              Infra<span className="text-amber-500">View</span>
            </span>
          </div>

          {/* Right — theme toggle */}
          <div className="flex items-center gap-2 animate-fade-in-up" style={{ animationDelay: '80ms', animationFillMode: 'both' }}>
            <button
              onClick={() => navigate('/settings')}
              className={cn(
                'group relative h-8 w-8 flex items-center justify-center rounded-sm',
                'border border-border text-muted-foreground',
                'hover:border-amber-500/50 hover:text-amber-500',
                'transition-all duration-200'
              )}
              title="Settings"
            >
              <div className="absolute inset-0 rounded-sm bg-amber-500/0 group-hover:bg-amber-500/5 transition-colors duration-200" />
              <Settings className="relative z-10 h-3.5 w-3.5 transition-transform duration-300 group-hover:rotate-12" />
            </button>
            {mounted && (
              <button
                onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
                className={cn(
                  'group relative h-8 w-8 flex items-center justify-center rounded-sm',
                  'border border-border text-muted-foreground',
                  'hover:border-amber-500/50 hover:text-amber-500',
                  'transition-all duration-200'
                )}
                title="Toggle theme"
              >
                <div className="absolute inset-0 rounded-sm bg-amber-500/0 group-hover:bg-amber-500/5 transition-colors duration-200" />
                {resolvedTheme === 'dark'
                  ? <Sun className="h-3.5 w-3.5 relative z-10 transition-transform duration-300 group-hover:rotate-45" />
                  : <Moon className="h-3.5 w-3.5 relative z-10 transition-transform duration-300 group-hover:-rotate-12" />
                }
              </button>
            )}
          </div>
        </div>
      </header>

      {/* ── Main ───────────────────────────────────────────────────── */}
      <main className="max-w-5xl mx-auto px-6 py-10">

        {/* Loading */}
        {loading && (
          <LoadingSkeleton variant="connections" />
        )}

        {/* Error */}
        {error && (
          <ErrorBanner message={error} onRetry={() => void fetchConnections()} />
        )}

        {/* Empty state */}
        {!loading && !error && connections.length === 0 && (
          <div className="animate-fade-in-up py-16" style={{ animationFillMode: 'both' }}>
            <EmptyState variant="no_connections" actionLabel="New Connection" onAction={openCreate} />
          </div>
        )}

        {/* Connection list */}
        {!loading && connections.length > 0 && (
          <>
            {/* Toolbar */}
            <div
              className="mb-6 flex items-center justify-between animate-fade-in-up"
              style={{ animationDelay: '40ms', animationFillMode: 'both' }}
            >
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-[0.15em]">
                  Connections
                </span>
                <span className="rounded-sm border border-border bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground tabular-nums">
                  {connections.length}
                </span>
              </div>
              <button
                onClick={openCreate}
                className={cn(
                  'group flex items-center gap-1.5',
                  'rounded-sm border border-amber-500/40 bg-amber-500/8 px-3 py-1.5',
                  'text-xs font-medium text-amber-500 font-mono',
                  'hover:bg-amber-500/15 hover:border-amber-500/70',
                  'transition-all duration-200'
                )}
              >
                <Plus className="h-3 w-3 transition-transform duration-200 group-hover:rotate-90" />
                New
              </button>
            </div>

            {/* Grid */}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {connections.map((conn, i) => (
                <div
                  key={conn.id}
                  className="animate-fade-in-up"
                  style={{ animationDelay: `${80 + i * 55}ms`, animationFillMode: 'both' }}
                >
                  <ConnectionCard connection={conn} onDelete={remove} onEdit={openEdit} />
                </div>
              ))}
            </div>
          </>
        )}
      </main>

      <ConnectionWizard open={wizardOpen} onOpenChange={handleWizardClose} editConnection={editingConnection} />
    </div>
  )
}
