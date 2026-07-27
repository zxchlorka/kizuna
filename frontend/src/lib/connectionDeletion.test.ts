import { beforeEach, describe, expect, it, vi } from 'vitest'
import { deleteConnectionEverywhere } from '@/lib/connectionDeletion'
import { useConnectionStore } from '@/stores/connections'
import { useLinksStore } from '@/stores/links'
import { useWorkspaceStore } from '@/stores/workspace'

vi.stubGlobal('window', globalThis)

const CONN = 'redis-1'

beforeEach(() => {
  useConnectionStore.setState({
    connections: [
      { id: CONN, name: 'redis', type: 'redis', host: 'localhost', port: 6379 },
      { id: 'kafka-1', name: 'kafka', type: 'kafka', host: 'localhost', port: 9092 },
    ],
  } as never)
  useLinksStore.setState({
    links: [
      {
        id: 'l1',
        source_conn_id: CONN,
        source_kind: 'redis',
        source_scope: 'w:*',
        target_conn_id: 'kafka-1',
        target_kind: 'kafka',
        target_topic: 'events',
      },
    ],
    loaded: true,
  } as never)
  useWorkspaceStore.setState({
    tabs: [
      { kind: 'object', id: 't1', connId: CONN, object: 'k', label: 'k', objectType: 'key' },
      { kind: 'object', id: 't2', connId: 'kafka-1', object: 'e', label: 'e', objectType: 'topic' },
    ] as never,
    openConnectionIds: [CONN, 'kafka-1'],
    activeTabId: 't1',
  })
})

describe('deleteConnectionEverywhere', () => {
  it('removes the connection, its links and its tabs after the API confirms', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch)

    await deleteConnectionEverywhere(CONN)

    expect(useConnectionStore.getState().connections.map((c) => c.id)).toEqual(['kafka-1'])
    expect(useLinksStore.getState().links).toEqual([])
    expect(useWorkspaceStore.getState().tabs.map((t) => t.id)).toEqual(['t2'])
    expect(useWorkspaceStore.getState().openConnectionIds).toEqual(['kafka-1'])
    vi.unstubAllGlobals()
    vi.stubGlobal('window', globalThis)
  })

  it('leaves every store untouched when the API rejects the delete', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 500 })) as unknown as typeof fetch
    )

    await expect(deleteConnectionEverywhere(CONN)).rejects.toThrow('nope')

    expect(useConnectionStore.getState().connections.map((c) => c.id)).toEqual([CONN, 'kafka-1'])
    expect(useLinksStore.getState().links.map((l) => l.id)).toEqual(['l1'])
    expect(useWorkspaceStore.getState().tabs.map((t) => t.id)).toEqual(['t1', 't2'])
    vi.unstubAllGlobals()
    vi.stubGlobal('window', globalThis)
  })
})
