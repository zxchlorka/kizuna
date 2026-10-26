import { useEffect, useMemo, useRef, useState } from 'react'
import { useTheme } from 'next-themes'
import { Layers, Plus, Search, Settings, Sun, Moon, X } from 'lucide-react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ConnectionTypeTabs, type ConnectionTypeFilter } from '@/components/ConnectionTypeTabs'
import {
  collectTags,
  filterConnectionsByName,
  filterConnectionsByTags,
  groupConnectionsByTag,
  nextTagSelection,
} from '@/lib/connectionGroups'
import { getConnectionTagClass } from '@/lib/connectionTags'
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

const GROUP_BY_TAG_KEY = 'kizuna:connections:groupByTag'

function readGroupByTag() {
  try {
    return localStorage.getItem(GROUP_BY_TAG_KEY) === '1'
  } catch {
    return false
  }
}

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

  const [query, setQuery] = useState('')
  const [groupByTag, setGroupByTag] = useState(readGroupByTag)

  const typeFiltered =
    selectedType === 'all'
      ? connections
      : connections.filter((connection) => connection.type === selectedType)
  const [selectedTags, setSelectedTags] = useState<ReadonlySet<string>>(new Set())
  const tagOptions = useMemo(() => collectTags(typeFiltered), [typeFiltered])
  // Drop selections whose tag vanished (type tab switched, connection retagged),
  // otherwise the list goes empty with no chip left to turn the filter off.
  const activeTags = useMemo(
    () => new Set([...selectedTags].filter((key) => tagOptions.some((t) => t.key === key))),
    [selectedTags, tagOptions]
  )
  const visibleConnections = filterConnectionsByTags(filterConnectionsByName(typeFiltered, query), activeTags)
  const groups = useMemo(
    () => (groupByTag ? groupConnectionsByTag(visibleConnections, activeTags) : []),
    [groupByTag, visibleConnections, activeTags]
  )

  const selectTag = (key: string, e: React.MouseEvent) =>
    setSelectedTags(nextTagSelection(activeTags, key, e.metaKey || e.ctrlKey || e.shiftKey))

  const toggleGroupByTag = () => {
    const next = !groupByTag
    setGroupByTag(next)
    try {
      localStorage.setItem(GROUP_BY_TAG_KEY, next ? '1' : '0')
    } catch {
      // Private mode or blocked storage: the toggle still works for this visit.
    }
  }

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

  // Spent once per mount, not on every run of the effect below: the connection
  // list changes identity whenever it is refetched, and those must not re-test
  // every datasource.
  const forcedThisMount = useRef(false)

  // Pruning is gated on the fetch having actually succeeded, not merely having
  // finished: the store sets loadedOnce on its error path too (see
  // stores/connections.ts), leaving connections at []. Without this, one
  // unreachable backend would drop the whole health cache — and since prune
  // persists, drop it from localStorage as well. The store refuses an empty list
  // on its own, so this is the second half of the same guard, placed here
  // because only the caller knows whether the list is trustworthy.
  //
  // Opening this screen — a reload, or coming back from a database — is the user
  // asking whether these are up right now, so the first pass forces past the
  // TTL. Reusing the cached answer there made a reload look ignored: the status
  // could not change however many times it was pressed, and only the per-card
  // test button did anything.
  useEffect(() => {
    if (!loadedOnce || error || connectionIds.length === 0) {
      return
    }
    pruneHealth(connectionIds)
    const force = !forcedThisMount.current
    forcedThisMount.current = true
    void refreshStaleHealth(connectionIds, { force })
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

              <div className="flex items-center gap-2 self-start md:self-auto">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
                    placeholder="Search by name"
                    aria-label="Search connections by name"
                    className={cn(
                      'h-8 w-52 rounded-sm border border-border bg-card/60 pl-8 pr-7 font-mono text-xs',
                      'placeholder:text-muted-foreground/60 focus-visible:border-amber-500/50 focus-visible:outline-none'
                    )}
                  />
                  {query && (
                    <button
                      type="button"
                      onClick={() => setQuery('')}
                      aria-label="Clear search"
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
                <button
                  type="button"
                  onClick={toggleGroupByTag}
                  aria-pressed={groupByTag}
                  className={cn(
                    'flex h-8 items-center gap-1.5 rounded-sm border px-2.5 font-mono text-xs transition-all duration-200',
                    groupByTag
                      ? 'border-amber-500/45 bg-amber-500/10 text-amber-500'
                      : 'border-border text-muted-foreground hover:border-amber-500/40 hover:text-foreground'
                  )}
                >
                  <Layers className="h-3 w-3" />
                  Group by tag
                </button>
                <button
                  onClick={openCreate}
                  className={cn(
                    'group flex h-8 items-center gap-1.5 rounded-sm border border-amber-500/40 bg-amber-500/8 px-3 font-mono text-xs font-medium text-amber-500',
                    'transition-all duration-200 hover:border-amber-500/70 hover:bg-amber-500/15'
                  )}
                >
                  <Plus className="h-3 w-3 transition-transform duration-200 group-hover:rotate-90" />
                  New
                </button>
              </div>
            </div>

            {tagOptions.length > 0 && (
              <div className="mb-6 flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by tag">
                {tagOptions.map((tag) => {
                  const active = activeTags.has(tag.key)
                  return (
                    <button
                      key={tag.key}
                      type="button"
                      aria-pressed={active}
                      onClick={(e) => selectTag(tag.key, e)}
                      title="Click to show only this tag, ⌘/Shift-click to add it"
                      className={cn(
                        'flex items-center gap-1.5 rounded-sm border px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] transition-all duration-200',
                        active || activeTags.size === 0
                          ? getConnectionTagClass(tag.label)
                          : 'border-border/60 bg-transparent text-muted-foreground opacity-60 hover:opacity-100',
                        active && 'ring-1 ring-amber-500/60'
                      )}
                    >
                      {tag.label}
                      <span className="tabular-nums opacity-70">{tag.count}</span>
                    </button>
                  )
                })}
                {activeTags.size > 0 && (
                  <button
                    type="button"
                    onClick={() => setSelectedTags(new Set())}
                    className="ml-1 font-mono text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    Clear
                  </button>
                )}
              </div>
            )}

            {visibleConnections.length === 0 ? (
              <div className="animate-fade-in-up py-10" style={{ animationDelay: '80ms', animationFillMode: 'both' }}>
                {query.trim() ? (
                  <EmptyState
                    variant="no_results"
                    title={`No connections match "${query.trim()}"`}
                    description="Check the spelling or clear the search to see every connection."
                    actionLabel="Clear search"
                    onAction={() => setQuery('')}
                  />
                ) : (
                  <EmptyState
                    variant="no_results"
                    title={`No ${selectedType} connections`}
                    description={`There are no ${selectedType} connections in this workspace yet. Switch back to all connections or create a new one.`}
                    actionLabel={selectedType === 'all' ? 'New Connection' : 'Show All'}
                    onAction={selectedType === 'all' ? openCreate : () => handleTypeChange('all')}
                  />
                )}
              </div>
            ) : groupByTag ? (
              <div className="space-y-8">
                {groups.map((group) => (
                  <section key={group.key || 'untagged'} aria-label={group.label || 'No tag'}>
                    <div className="mb-3 flex items-center gap-3">
                      {group.label ? (
                        <span
                          className={cn(
                            'rounded-sm border px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.14em]',
                            getConnectionTagClass(group.label)
                          )}
                        >
                          {group.label}
                        </span>
                      ) : (
                        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                          No tag
                        </span>
                      )}
                      <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                        {group.connections.length}
                      </span>
                      <div className="h-px flex-1 bg-border/60" />
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                      {group.connections.map((conn) => (
                        <ConnectionCard key={conn.id} connection={conn} onDelete={deleteConnectionEverywhere} onEdit={openEdit} />
                      ))}
                    </div>
                  </section>
                ))}
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
