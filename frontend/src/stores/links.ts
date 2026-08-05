import { create } from 'zustand'
import { fetchWithTimeout, throwOnApiError } from '@/lib/http'
import type { LinkInput, LinkRecord } from '@/types/api'

interface LinksStore {
  links: LinkRecord[]
  loaded: boolean
  fetch: () => Promise<void>
  create: (input: LinkInput) => Promise<LinkRecord>
  update: (id: string, input: LinkInput) => Promise<LinkRecord>
  remove: (id: string) => Promise<void>
  removeForConnection: (connId: string) => void
  linksFor: (sourceConnId: string, scope: string) => LinkRecord[]
}

export const useLinksStore = create<LinksStore>((set, get) => ({
  links: [],
  loaded: false,

  fetch: async () => {
    const res = await fetchWithTimeout('/api/links')
    await throwOnApiError(res)
    const links = (await res.json()) as LinkRecord[]
    set({ links: links ?? [], loaded: true })
  },

  create: async (input: LinkInput) => {
    const res = await fetchWithTimeout('/api/links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    await throwOnApiError(res)
    const link = (await res.json()) as LinkRecord
    set({ links: [...get().links, link] })
    return link
  },

  update: async (id: string, input: LinkInput) => {
    const res = await fetchWithTimeout(`/api/links/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    await throwOnApiError(res)
    const updated = (await res.json()) as LinkRecord
    set({ links: get().links.map((link) => (link.id === id ? updated : link)) })
    return updated
  },

  remove: async (id: string) => {
    const res = await fetchWithTimeout(`/api/links/${id}`, { method: 'DELETE' })
    await throwOnApiError(res)
    set({ links: get().links.filter((link) => link.id !== id) })
  },

  // Local half of the connection-delete cascade. DELETE /api/connections/:id
  // already removed these links server-side in the same mutation, so this only
  // forgets them locally — deliberately without a request per link.
  removeForConnection: (connId: string) => {
    const links = get().links
    const remaining = links.filter((link) => link.source_conn_id !== connId && link.target_conn_id !== connId)
    if (remaining.length === links.length) {
      return
    }
    set({ links: remaining })
  },

  linksFor: (sourceConnId, scope) =>
    get().links.filter((link) => link.source_conn_id === sourceConnId && link.source_scope === scope),
}))
