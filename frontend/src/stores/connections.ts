import { create } from 'zustand'
import type { Connection, ConnectionInput, TestResult } from '@/types/api'

const CONNECTION_TEST_TIMEOUT_MS = 8_000

function normalizeConnection(connection: Connection): Connection {
  if (connection.type !== 'redis') {
    return connection
  }

  const redisConfig = connection.redis_config

  return {
    ...connection,
    mode: connection.mode ?? redisConfig?.mode ?? 'standalone',
    separator: connection.separator ?? redisConfig?.separator ?? ':',
    tlsEnabled: connection.tlsEnabled ?? redisConfig?.tls_enabled ?? false,
    masterName: connection.masterName ?? redisConfig?.master_name,
    clusterAddresses: connection.clusterAddresses ?? redisConfig?.addresses ?? [],
    sentinelAddresses: connection.sentinelAddresses ?? redisConfig?.sentinel_addrs ?? [],
    database: connection.database ?? redisConfig?.database ?? '0',
    username: connection.username ?? redisConfig?.username ?? '',
  }
}

function normalizeConnections(connections: Connection[]): Connection[] {
  return connections.map(normalizeConnection)
}

interface ConnectionStore {
  connections: Connection[]
  loading: boolean
  error: string | null
  fetch: () => Promise<void>
  create: (input: ConnectionInput) => Promise<Connection>
  update: (id: string, input: Partial<ConnectionInput>) => Promise<Connection>
  remove: (id: string) => Promise<void>
  test: (id: string) => Promise<TestResult>
}

export const useConnectionStore = create<ConnectionStore>((set, get) => ({
  connections: [],
  loading: false,
  error: null,

  fetch: async () => {
    set({ loading: true, error: null })
    try {
      const res = await fetch('/api/connections')
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(body.error || res.statusText)
      }
      const connections: Connection[] = normalizeConnections(await res.json())
      set({ connections, loading: false })
    } catch (e) {
      set({ error: (e as Error).message, loading: false })
    }
  },

  create: async (input: ConnectionInput) => {
    const res = await fetch('/api/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error(body.error || res.statusText)
    }
    const connection: Connection = normalizeConnection(await res.json())
    set({ connections: [...get().connections, connection] })
    return connection
  },

  update: async (id: string, input: Partial<ConnectionInput>) => {
    const res = await fetch(`/api/connections/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error(body.error || res.statusText)
    }
    const connection: Connection = normalizeConnection(await res.json())
    set({ connections: get().connections.map((c) => (c.id === id ? connection : c)) })
    return connection
  },

  remove: async (id: string) => {
    const res = await fetch(`/api/connections/${id}`, { method: 'DELETE' })
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error(body.error || res.statusText)
    }
    set({ connections: get().connections.filter((c) => c.id !== id) })
  },

  test: async (id: string) => {
    const controller = new AbortController()
    const timeoutId = window.setTimeout(() => controller.abort(), CONNECTION_TEST_TIMEOUT_MS)

    let res: Response
    try {
      res = await fetch(`/api/connections/${id}/test`, {
        method: 'POST',
        signal: controller.signal,
      })
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        throw new Error('Connection test timed out after 8s')
      }
      throw e
    } finally {
      window.clearTimeout(timeoutId)
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error(body.error || res.statusText)
    }
    const result: TestResult = await res.json()
    return result
  },
}))
