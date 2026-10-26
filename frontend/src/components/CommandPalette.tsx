import { useEffect, useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { ConnectionTypeIcon } from '@/components/ConnectionTypeIcon'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { buildPaletteEntries, mergeNamespaces, redisSeparator, searchPalette, topNamespaces, type PaletteEntry } from '@/lib/commandPalette'
import { cn } from '@/lib/utils'
import { PALETTE_SHORTCUT, useCommandPaletteStore } from '@/stores/commandPalette'
import { useConnectionStore } from '@/stores/connections'
import { useWorkspaceStore } from '@/stores/workspace'

const TYPE_LABEL: Record<string, string> = { table: 'table', view: 'view', kafka_topic: 'topic', namespace: 'namespace' }

const NAMESPACES_KEY = 'kizuna:palette:redisNamespaces'

function readNamespaces(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(NAMESPACES_KEY)
    return raw ? (JSON.parse(raw) as Record<string, string[]>) : {}
  } catch {
    return {}
  }
}

// ⌘K / Ctrl+K from anywhere: jump to a connection, to a table, view or topic
// whose tree has already been opened, or to a Redis namespace seen in any
// earlier visit.
export function CommandPalette() {
  const navigate = useNavigate()
  const connections = useConnectionStore((state) => state.connections)
  const treeItems = useWorkspaceStore((state) => state.treeItems)
  const openTab = useWorkspaceStore((state) => state.openTab)
  const setKeyPattern = useWorkspaceStore((state) => state.setKeyPattern)
  const open = useCommandPaletteStore((state) => state.open)
  const setOpen = useCommandPaletteStore((state) => state.setOpen)
  const toggle = useCommandPaletteStore((state) => state.toggle)
  const [namespaces, setNamespaces] = useState(readNamespaces)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        toggle()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [toggle])

  // Remember every Redis namespace a tree has shown, so the next visit can jump
  // to it without opening the connection first.
  useEffect(() => {
    let changed = false
    const next = { ...namespaces }
    for (const conn of connections) {
      if (conn.type !== 'redis') continue
      const seen = topNamespaces(treeItems[`${conn.id}::`] ?? [], redisSeparator(conn))
      if (seen.length === 0) continue
      const merged = mergeNamespaces(next[conn.id], seen)
      if (merged.length !== (next[conn.id]?.length ?? 0)) {
        next[conn.id] = merged
        changed = true
      }
    }
    if (!changed) return
    setNamespaces(next)
    try {
      localStorage.setItem(NAMESPACES_KEY, JSON.stringify(next))
    } catch {
      // Blocked storage: remembered for this visit only.
    }
  }, [connections, treeItems, namespaces])

  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  const entries = useMemo(() => (open ? buildPaletteEntries(connections, treeItems, namespaces) : []), [open, connections, treeItems, namespaces])
  const results = useMemo(() => searchPalette(entries, query), [entries, query])
  const typeById = useMemo(() => new Map(connections.map((c) => [c.id, c.type])), [connections])

  useEffect(() => setActive(0), [query])
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const choose = (entry: PaletteEntry) => {
    setOpen(false)
    navigate(`/connections/${entry.connId}`)
    if (entry.objectType === 'namespace' && entry.object) void setKeyPattern(entry.connId, entry.object)
    else if (entry.object && entry.objectType) openTab(entry.connId, entry.object, entry.objectType)
  }

  const onInputKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((i) => Math.min(i + 1, results.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (event.key === 'Enter' && results[active]) {
      event.preventDefault()
      choose(results[active])
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="top-[18%] max-w-xl translate-y-0 gap-0 overflow-hidden p-0 data-[state=open]:slide-in-from-top-[16%]">
        <DialogTitle className="sr-only">Go to</DialogTitle>
        <DialogDescription className="sr-only">Search connections, the tables, views and topics already loaded in their trees, and Redis namespaces browsed before.</DialogDescription>
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Go to connection, table, topic or Redis namespace"
            aria-label="Go to connection, table or topic"
            role="combobox"
            aria-expanded
            aria-controls="command-palette-list"
            aria-activedescendant={results[active] ? `palette-${active}` : undefined}
            spellCheck={false}
            autoComplete="off"
            className="h-12 flex-1 bg-transparent font-mono text-sm outline-none placeholder:text-muted-foreground/60"
          />
          <kbd className="rounded-sm border border-border px-1.5 font-mono text-[10px] text-muted-foreground">esc</kbd>
        </div>

        <div ref={listRef} id="command-palette-list" role="listbox" className="max-h-[50vh] overflow-y-auto p-1.5">
          {results.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              Nothing matches what has been opened so far.
            </p>
          ) : (
            results.map((entry, index) => {
              const type = typeById.get(entry.connId)
              return (
                <button
                  key={entry.id}
                  id={`palette-${index}`}
                  data-index={index}
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  onMouseMove={() => setActive(index)}
                  onClick={() => choose(entry)}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-sm px-2.5 py-2 text-left',
                    index === active ? 'bg-amber-500/10' : 'hover:bg-muted/40'
                  )}
                >
                  {type && <ConnectionTypeIcon type={type} className="h-4 w-4 shrink-0" />}
                  {entry.object ? (
                    <>
                      <span className="min-w-0 flex-1 truncate font-mono text-sm">{entry.object}</span>
                      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                        {TYPE_LABEL[entry.objectType ?? ''] ?? entry.objectType} · {entry.connName}
                      </span>
                    </>
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-sm">{entry.connName}</span>
                  )}
                </button>
              )
            })
          )}
        </div>

        <footer className="flex items-end justify-between gap-6 border-t border-border/70 bg-muted/10 px-4 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
          <p className="max-w-sm">
            Tables, views and topics appear once you have opened their connection. Redis namespaces you have browsed are
            remembered; keys themselves are never scanned from here.
          </p>
          <div className="flex shrink-0 items-center gap-3 font-mono text-[10px] text-muted-foreground/70">
            <span>↑↓ move</span>
            <span>↵ open</span>
            <span>{PALETTE_SHORTCUT} toggle</span>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  )
}
