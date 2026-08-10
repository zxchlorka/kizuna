import { useEffect, useState } from 'react'
import { Filter, X } from 'lucide-react'
import { useWorkspaceStore } from '@/stores/workspace'

interface RedisKeyFilterProps {
  connId: string
}

// Debounce before a keystroke turns into a keyspace SCAN. Long enough that
// typing a prefix does not fire a scan per character, short enough that the
// tree still feels like it is reacting to the input.
const FILTER_DEBOUNCE_MS = 350

// Narrows the Redis tree to keys matching a glob. Unlike RedisKeyLookup, which
// opens one exact key, this filters every level of the tree at once: the
// pattern is applied by SCAN MATCH on the server, so it finds keys that were
// never loaded rather than filtering the rows already on screen.
export function RedisKeyFilter({ connId }: RedisKeyFilterProps) {
  const pattern = useWorkspaceStore((state) => state.keyPatternByConnection[connId] ?? '')
  const setKeyPattern = useWorkspaceStore((state) => state.setKeyPattern)
  const [draft, setDraft] = useState(pattern)

  // Follow the store when the pattern changes elsewhere — switching connections
  // reuses this component, and its draft would otherwise show the old value.
  useEffect(() => {
    setDraft(pattern)
  }, [connId, pattern])

  useEffect(() => {
    if (draft === pattern) {
      return
    }
    const timer = setTimeout(() => void setKeyPattern(connId, draft.trim()), FILTER_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [draft, pattern, connId, setKeyPattern])

  return (
    <div className="relative mb-2">
      <Filter className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            void setKeyPattern(connId, draft.trim())
          }
          if (event.key === 'Escape' && draft) {
            event.preventDefault()
            setDraft('')
          }
        }}
        placeholder="Filter keys, e.g. session:*"
        spellCheck={false}
        autoComplete="off"
        aria-label="Filter Redis keys by pattern"
        className="h-8 w-full rounded-sm border border-border bg-background pl-7 pr-7 font-mono text-xs outline-none placeholder:text-muted-foreground focus:border-amber-500/50"
      />
      {draft && (
        <button
          type="button"
          onClick={() => setDraft('')}
          title="Clear filter"
          aria-label="Clear key filter"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}
