import { create } from 'zustand'
import { useConnectionStore } from '@/stores/connections'

export type ConnectionHealthStatus = 'unknown' | 'healthy' | 'unhealthy'

export interface ConnectionHealthEntry {
  status: ConnectionHealthStatus
  checking: boolean
  updatedAt: number | null
  latencyMs: number | null
  error: string | null
}

interface ConnectionHealthStore {
  hydrated: boolean
  entries: Record<string, ConnectionHealthEntry>
  hydrate: () => void
  prune: (ids: string[]) => void
  refresh: (id: string, options?: { force?: boolean }) => Promise<ConnectionHealthEntry>
  refreshStale: (ids: string[]) => Promise<void>
}

const STORAGE_KEY = 'infraview-connection-health'
const HEALTH_TTL_MS = 60_000
const pendingChecks = new Map<string, Promise<ConnectionHealthEntry>>()

function defaultEntry(): ConnectionHealthEntry {
  return {
    status: 'unknown',
    checking: false,
    updatedAt: null,
    latencyMs: null,
    error: null,
  }
}

function isFresh(entry?: ConnectionHealthEntry | null): boolean {
  return Boolean(entry?.updatedAt && Date.now()-(entry.updatedAt ?? 0) < HEALTH_TTL_MS)
}

function loadPersistedEntries(): Record<string, ConnectionHealthEntry> {
  if (typeof window === 'undefined') {
    return {}
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return {}
    }

    const parsed = JSON.parse(raw) as Record<string, ConnectionHealthEntry>
    const next: Record<string, ConnectionHealthEntry> = {}
    Object.entries(parsed).forEach(([id, entry]) => {
      if (!entry || typeof entry !== 'object') {
        return
      }
      if (!isFresh(entry)) {
        return
      }
      next[id] = {
        status: entry.status === 'healthy' || entry.status === 'unhealthy' ? entry.status : 'unknown',
        checking: false,
        updatedAt: entry.updatedAt ?? null,
        latencyMs: entry.latencyMs ?? null,
        error: entry.error ?? null,
      }
    })
    return next
  } catch {
    return {}
  }
}

function persistEntries(entries: Record<string, ConnectionHealthEntry>) {
  if (typeof window === 'undefined') {
    return
  }

  const serializable: Record<string, ConnectionHealthEntry> = {}
  Object.entries(entries).forEach(([id, entry]) => {
    if (isFresh(entry) && !entry.checking) {
      serializable[id] = entry
    }
  })

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable))
  } catch {
    // Ignore persistence failures. Health cache is best-effort UI state.
  }
}

export function isConnectionHealthStale(entry?: ConnectionHealthEntry | null): boolean {
  return !isFresh(entry)
}

export const useConnectionHealthStore = create<ConnectionHealthStore>((set, get) => ({
  hydrated: false,
  entries: {},

  hydrate: () => {
    if (get().hydrated) {
      return
    }
    const entries = loadPersistedEntries()
    set({ hydrated: true, entries })
  },

  prune: (ids: string[]) => {
    const allowed = new Set(ids)
    set((state) => {
      const nextEntries: Record<string, ConnectionHealthEntry> = {}
      Object.entries(state.entries).forEach(([id, entry]) => {
        if (allowed.has(id)) {
          nextEntries[id] = entry
        }
      })
      persistEntries(nextEntries)
      return { entries: nextEntries }
    })
  },

  refresh: async (id: string, options?: { force?: boolean }) => {
    const existing = get().entries[id]
    if (!options?.force && isFresh(existing)) {
      return existing
    }

    const pending = pendingChecks.get(id)
    if (pending) {
      return pending
    }

    set((state) => {
      const next = {
        ...defaultEntry(),
        ...state.entries[id],
        checking: true,
      }
      const entries = { ...state.entries, [id]: next }
      persistEntries(entries)
      return { entries }
    })

    const request = useConnectionStore.getState()
      .test(id)
      .then((result) => {
        const next: ConnectionHealthEntry = {
          status: result.ok ? 'healthy' : 'unhealthy',
          checking: false,
          updatedAt: Date.now(),
          latencyMs: result.latency_ms ?? null,
          error: result.ok ? null : result.error ?? 'Connection test failed.',
        }
        set((state) => {
          const entries = { ...state.entries, [id]: next }
          persistEntries(entries)
          return { entries }
        })
        return next
      })
      .catch((error: Error) => {
        const next: ConnectionHealthEntry = {
          status: 'unhealthy',
          checking: false,
          updatedAt: Date.now(),
          latencyMs: null,
          error: error.message,
        }
        set((state) => {
          const entries = { ...state.entries, [id]: next }
          persistEntries(entries)
          return { entries }
        })
        throw error
      })
      .finally(() => {
        pendingChecks.delete(id)
      })

    pendingChecks.set(id, request)
    return request
  },

  refreshStale: async (ids: string[]) => {
    for (const id of ids) {
      const entry = get().entries[id]
      if (isFresh(entry) || entry?.checking) {
        continue
      }
      try {
        await get().refresh(id)
      } catch {
        // Keep background refresh best-effort. The card will render the error state.
      }
    }
  },
}))
