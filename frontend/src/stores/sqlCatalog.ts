import { create } from 'zustand'
import type { SqlCatalog } from '@/types/api'

interface SqlCatalogStore {
  catalogs: Record<string, SqlCatalog>
  fetch: (connId: string) => Promise<void>
}

const inflight = new Map<string, Promise<void>>()

export const useSqlCatalogStore = create<SqlCatalogStore>((set, get) => ({
  catalogs: {},

  fetch: async (connId) => {
    if (get().catalogs[connId]) {
      return
    }
    const pending = inflight.get(connId)
    if (pending) {
      return pending
    }

    const request = (async () => {
      try {
        const res = await fetch(`/api/connections/${connId}/sql-catalog`)
        if (!res.ok) {
          return
        }
        const catalog: SqlCatalog = await res.json()
        set((state) => ({ catalogs: { ...state.catalogs, [connId]: catalog } }))
      } catch {
        // Autocomplete falls back to the request-based source when the catalog
        // is unavailable; no error surfaced to the user.
      } finally {
        inflight.delete(connId)
      }
    })()

    inflight.set(connId, request)
    return request
  },
}))
