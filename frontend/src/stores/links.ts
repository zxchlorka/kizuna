import { create } from 'zustand'
import { fetchWithTimeout } from '@/lib/http'
import type { LinkInput, LinkRecord } from '@/types/api'

interface LinksStore {
  links: LinkRecord[]
  loaded: boolean
  fetch: () => Promise<void>
  create: (input: LinkInput) => Promise<LinkRecord>
  update: (id: string, input: LinkInput) => Promise<LinkRecord>
  remove: (id: string) => Promise<void>
  linksFor: (sourceConnId: string, scope: string) => LinkRecord[]
}

export const useLinksStore = create<LinksStore>((set, get) => ({
  links: [],
  loaded: false,

  fetch: async () => {
    const res = await fetchWithTimeout('/api/links')
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error(body.error || res.statusText)
    }
    const links = (await res.json()) as LinkRecord[]
    set({ links: links ?? [], loaded: true })
  },

  create: async (input: LinkInput) => {
    const res = await fetchWithTimeout('/api/links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error(body.error || res.statusText)
    }
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
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error(body.error || res.statusText)
    }
    const updated = (await res.json()) as LinkRecord
    set({ links: get().links.map((link) => (link.id === id ? updated : link)) })
    return updated
  },

  remove: async (id: string) => {
    const res = await fetchWithTimeout(`/api/links/${id}`, { method: 'DELETE' })
    if (!res.ok && res.status !== 204) {
      const body = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error(body.error || res.statusText)
    }
    set({ links: get().links.filter((link) => link.id !== id) })
  },

  linksFor: (sourceConnId, scope) =>
    get().links.filter((link) => link.source_conn_id === sourceConnId && link.source_scope === scope),
}))
