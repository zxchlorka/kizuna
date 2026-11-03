import { create } from 'zustand'
import { fetchWithTimeout, throwOnApiError } from '@/lib/http'
import { findConnection, isDatabaseConnectionId } from '@/lib/databaseConnection'
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
  moveToFolder: (id: string, folderId: string) => Promise<void>
  // ids is the folder's whole new order; one dragged in from another folder moves with it.
  arrange: (folderId: string, ids: string[]) => Promise<void>
  // Mirrors a folder deletion: the backend lifts its connections into the parent.
  liftFolder: (folderId: string, parentId: string) => void
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
        await throwOnApiError(res)
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
    await throwOnApiError(res)
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
    await throwOnApiError(res)
    const connection: Connection = await res.json()
    set({ connections: get().connections.map((c) => (c.id === id ? connection : c)) })
    return connection
  },

  updateVisibleSchemas: async (id: string, visibleSchemas: string[] | null) => {
    // A runtime database is not stored, so neither is its schema filter: it
    // lives in the workspace for this session only.
    if (isDatabaseConnectionId(id)) {
      const connection = findConnection(get().connections, id)
      if (!connection) {
        throw new Error('Connection not found in store')
      }
      return { ...connection, visible_schemas: visibleSchemas }
    }
    const res = await fetchWithTimeout(`/api/connections/${id}/visible-schemas`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visible_schemas: visibleSchemas }),
    })
    await throwOnApiError(res)

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
    await throwOnApiError(res)
    set({ connections: get().connections.filter((c) => c.id !== id) })
  },

  moveToFolder: async (id: string, folderId: string) => {
    const res = await fetchWithTimeout(`/api/connections/${id}/folder`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder_id: folderId }),
    })
    await throwOnApiError(res)
    // Mirrors the backend: a moved connection goes to the end of its new folder.
    const last = Math.max(0, ...get().connections.filter((c) => (c.folder_id ?? '') === folderId && c.id !== id).map((c) => c.position ?? 0))
    set({
      connections: get().connections.map((c) =>
        c.id === id ? { ...c, folder_id: folderId || undefined, position: last + 1 } : c
      ),
    })
  },

  arrange: async (folderId: string, ids: string[]) => {
    const res = await fetchWithTimeout('/api/connections/arrange', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder_id: folderId, connection_ids: ids }),
    })
    await throwOnApiError(res)
    const positions = new Map(ids.map((id, index) => [id, index + 1]))
    set({
      connections: get().connections.map((c) =>
        positions.has(c.id) ? { ...c, folder_id: folderId || undefined, position: positions.get(c.id) } : c
      ),
    })
  },

  liftFolder: (folderId: string, parentId: string) => {
    set({
      connections: get().connections.map((c) =>
        c.folder_id === folderId ? { ...c, folder_id: parentId || undefined } : c
      ),
    })
  },

  test: async (id: string) => {
    const res = await fetchWithTimeout(`/api/connections/${id}/test`, { method: 'POST' })
    await throwOnApiError(res)
    const result: TestResult = await res.json()
    return result
  },

  testConfig: async (input: Partial<ConnectionInput> & { id?: string }) => {
    const res = await fetchWithTimeout('/api/connections/test-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    await throwOnApiError(res)
    const result: TestResult = await res.json()
    return result
  },
}))
