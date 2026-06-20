import { create } from 'zustand'
import { fetchWithTimeout } from '@/lib/http'
import type { Connection, ConnectionInput, TestResult } from '@/types/api'

interface ConnectionStore {
  connections: Connection[]
  loading: boolean
  loadedOnce: boolean
  error: string | null
  fetch: () => Promise<void>
  create: (input: ConnectionInput) => Promise<Connection>
  update: (id: string, input: Partial<ConnectionInput>) => Promise<Connection>
  updateVisibleSchemas: (id: string, visibleSchemas: string[] | null) => Promise<Connection>
  remove: (id: string) => Promise<void>
  test: (id: string) => Promise<TestResult>
  testConfig: (input: Partial<ConnectionInput> & { id?: string }) => Promise<TestResult>
}

let pendingConnectionsFetch: Promise<void> | null = null

export const useConnectionStore = create<ConnectionStore>((set, get) => ({
  connections: [],
  loading: false,
  loadedOnce: false,
  error: null,

  fetch: async () => {
    if (pendingConnectionsFetch) {
      return pendingConnectionsFetch
    }
    if (get().loading) {
      return
    }

    pendingConnectionsFetch = (async () => {
      set({ loading: true, error: null })
      try {
        const res = await fetchWithTimeout('/api/connections')
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: res.statusText }))
          throw new Error(body.error || res.statusText)
        }
        const connections: Connection[] = await res.json()
        set({ connections, loading: false, loadedOnce: true })
      } catch (e) {
        set({ error: (e as Error).message, loading: false, loadedOnce: true })
      } finally {
        pendingConnectionsFetch = null
      }
    })()

    return pendingConnectionsFetch
  },

  create: async (input: ConnectionInput) => {
    const res = await fetchWithTimeout('/api/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error(body.error || res.statusText)
    }
    const connection: Connection = await res.json()
    set({ connections: [...get().connections, connection] })
    return connection
  },

  update: async (id: string, input: Partial<ConnectionInput>) => {
    const res = await fetchWithTimeout(`/api/connections/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error(body.error || res.statusText)
    }
    const connection: Connection = await res.json()
    set({ connections: get().connections.map((c) => (c.id === id ? connection : c)) })
    return connection
  },

  updateVisibleSchemas: async (id: string, visibleSchemas: string[] | null) => {
    const res = await fetchWithTimeout(`/api/connections/${id}/visible-schemas`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visible_schemas: visibleSchemas }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error(body.error || res.statusText)
    }

    const body: { id: string; visible_schemas: string[] | null } = await res.json()
    const current = get().connections.find((connection) => connection.id === body.id)
    if (!current) {
      throw new Error('Connection not found in store')
    }

    const connection: Connection = {
      ...current,
      visible_schemas: body.visible_schemas,
    }
    set({ connections: get().connections.map((c) => (c.id === id ? connection : c)) })
    return connection
  },

  remove: async (id: string) => {
    const res = await fetchWithTimeout(`/api/connections/${id}`, { method: 'DELETE' })
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error(body.error || res.statusText)
    }
    set({ connections: get().connections.filter((c) => c.id !== id) })
  },

  test: async (id: string) => {
    const res = await fetchWithTimeout(`/api/connections/${id}/test`, { method: 'POST' })
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error(body.error || res.statusText)
    }
    const result: TestResult = await res.json()
    return result
  },

  testConfig: async (input: Partial<ConnectionInput> & { id?: string }) => {
    const res = await fetchWithTimeout('/api/connections/test-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error(body.error || res.statusText)
    }
    const result: TestResult = await res.json()
    return result
  },
}))
