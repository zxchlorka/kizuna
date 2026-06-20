import { useState, type FormEvent } from 'react'
import { Loader2, Search } from 'lucide-react'
import { useDataStore } from '@/stores/data'
import { useWorkspaceStore } from '@/stores/workspace'

interface RedisKeyLookupProps {
  connId: string
}

// Opens a Redis key by its exact name. Resolves the key's type with a single
// O(1) TYPE lookup (no SCAN) and opens it as a tab; shows an inline error when
// the key does not exist.
export function RedisKeyLookup({ connId }: RedisKeyLookupProps) {
  const resolveObjectType = useDataStore((state) => state.resolveObjectType)
  const openTab = useWorkspaceStore((state) => state.openTab)
  const [value, setValue] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    const key = value.trim()
    if (!key || loading) {
      return
    }
    setLoading(true)
    setError(null)
    try {
      const objectType = await resolveObjectType(connId, key)
      openTab(connId, key, objectType)
      setValue('')
    } catch (lookupError) {
      setError((lookupError as Error).message || 'Key not found')
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mb-2">
      <div className="relative">
        {loading ? (
          <Loader2 className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />
        ) : (
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        )}
        <input
          value={value}
          onChange={(event) => {
            setValue(event.target.value)
            if (error) {
              setError(null)
            }
          }}
          placeholder="Open key by name…"
          spellCheck={false}
          autoComplete="off"
          className="h-8 w-full rounded-sm border border-border bg-background pl-7 pr-2 font-mono text-xs outline-none placeholder:text-muted-foreground focus:border-red-500/50"
        />
      </div>
      {error && <div className="mt-1 font-mono text-[11px] text-destructive">{error}</div>}
    </form>
  )
}
