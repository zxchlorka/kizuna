import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkspaceStore } from '@/stores/workspace'
import { useConnectionStore } from '@/stores/connections'

// These tests drive the REAL workspace store against a mocked fetch. They pin the
// stale-while-revalidate contract for the Redis tree Refresh button: the old tree
// stays on screen while the new one loads, a failed refresh is non-destructive,
// and a late response from an older refresh can never overwrite a newer one.
//
// fetchWithTimeout uses window.setTimeout/clearTimeout; point window at globalThis
// for the node test environment.
vi.stubGlobal('window', globalThis)

const CONN = 'redis-1'
const rootKey = `${CONN}::`
const nsKey = (ns: string) => `${CONN}::${ns}`

function keyPage(names: string[], nextCursor = '') {
  return {
    objects: names.map((name) => ({ name, type: 'key' })),
    next_cursor: nextCursor,
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

// A promise whose resolution the test controls, so state can be inspected while
// the refresh is still in flight.
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  useConnectionStore.setState({
    connections: [
      { id: CONN, name: 'redis', type: 'redis', host: 'localhost', port: 6379 },
    ],
  } as never)
  useWorkspaceStore.setState({
    treeItems: {},
    treeCursors: {},
    treeLoadingByKey: {},
    treeErrorByKey: {},
    treeLoadedByKey: {},
    treeErrorsByConnection: {},
    treeRefreshingByConnection: {},
    expandedSchemas: new Set<string>(),
    selectedNodeByConnection: {},
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.stubGlobal('window', globalThis)
})

function names(key: string): string[] {
  return (useWorkspaceStore.getState().treeItems[key] ?? []).map((item) => item.name)
}

describe('refreshTree — stale-while-revalidate', () => {
  it('picks up keys added externally without a store reload', async () => {
    useWorkspaceStore.setState({
      treeItems: { [rootKey]: keyPage(['profile:1', 'profile:2']).objects as never },
      treeLoadedByKey: { [rootKey]: true },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(keyPage(['profile:1', 'profile:2', 'profile:16', 'profile:17']))) as unknown as typeof fetch
    )

    await useWorkspaceStore.getState().refreshTree(CONN)

    expect(names(rootKey)).toEqual(['profile:1', 'profile:2', 'profile:16', 'profile:17'])
  })

  it('drops a key deleted externally', async () => {
    useWorkspaceStore.setState({
      treeItems: { [rootKey]: keyPage(['profile:1', 'profile:2']).objects as never },
      treeLoadedByKey: { [rootKey]: true },
    })
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(keyPage(['profile:1']))) as unknown as typeof fetch)

    await useWorkspaceStore.getState().refreshTree(CONN)

    expect(names(rootKey)).toEqual(['profile:1'])
  })

  it('keeps the previous tree visible while the refresh is in flight', async () => {
    useWorkspaceStore.setState({
      treeItems: { [rootKey]: keyPage(['profile:1', 'profile:2']).objects as never },
      treeLoadedByKey: { [rootKey]: true },
    })
    const gate = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn(() => gate.promise) as unknown as typeof fetch)

    const refresh = useWorkspaceStore.getState().refreshTree(CONN)
    await Promise.resolve()

    // The old rows must still be rendered, and the connection must be marked as
    // refreshing (scoped, not the global treeLoading flag).
    expect(names(rootKey)).toEqual(['profile:1', 'profile:2'])
    expect(useWorkspaceStore.getState().treeRefreshingByConnection[CONN]).toBe(true)

    gate.resolve(jsonResponse(keyPage(['profile:9'])))
    await refresh

    expect(names(rootKey)).toEqual(['profile:9'])
    expect(useWorkspaceStore.getState().treeRefreshingByConnection[CONN]).toBeFalsy()
  })

  it('leaves the previous tree intact when the refresh fails', async () => {
    useWorkspaceStore.setState({
      treeItems: { [rootKey]: keyPage(['profile:1', 'profile:2']).objects as never },
      treeCursors: { [rootKey]: 'cursor-42' },
      treeLoadedByKey: { [rootKey]: true },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })) as unknown as typeof fetch)

    await useWorkspaceStore.getState().refreshTree(CONN)

    expect(names(rootKey)).toEqual(['profile:1', 'profile:2'])
    expect(useWorkspaceStore.getState().treeCursors[rootKey]).toBe('cursor-42')
    expect(useWorkspaceStore.getState().treeErrorsByConnection[CONN]).toBeTruthy()
    expect(useWorkspaceStore.getState().treeRefreshingByConnection[CONN]).toBeFalsy()
  })

  it('re-reads an expanded namespace and leaves it expanded', async () => {
    useWorkspaceStore.setState({
      treeItems: {
        [rootKey]: [{ name: 'profile', type: 'schema' }] as never,
        [nsKey('profile')]: keyPage(['profile:1']).objects as never,
      },
      treeLoadedByKey: { [rootKey]: true, [nsKey('profile')]: true },
      expandedSchemas: new Set([nsKey('profile')]),
    })
    const requested: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        requested.push(String(url))
        return String(url).includes('path=profile')
          ? jsonResponse(keyPage(['profile:1', 'profile:2']))
          : jsonResponse({ objects: [{ name: 'profile', type: 'schema' }], next_cursor: '' })
      }) as unknown as typeof fetch
    )

    await useWorkspaceStore.getState().refreshTree(CONN)

    expect(requested.some((url) => url.includes('path=profile'))).toBe(true)
    expect(names(nsKey('profile'))).toEqual(['profile:1', 'profile:2'])
    expect(useWorkspaceStore.getState().expandedSchemas.has(nsKey('profile'))).toBe(true)
  })

  it('does not request a namespace that is not expanded', async () => {
    useWorkspaceStore.setState({
      treeItems: { [rootKey]: [{ name: 'profile', type: 'schema' }] as never },
      treeLoadedByKey: { [rootKey]: true },
      expandedSchemas: new Set<string>(),
    })
    const requested: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        requested.push(String(url))
        return jsonResponse({ objects: [{ name: 'profile', type: 'schema' }], next_cursor: '' })
      }) as unknown as typeof fetch
    )

    await useWorkspaceStore.getState().refreshTree(CONN)

    expect(requested.filter((url) => url.includes('path=')).length).toBe(0)
  })

  it('drops cached pages for a namespace that no longer exists', async () => {
    useWorkspaceStore.setState({
      treeItems: {
        [rootKey]: [
          { name: 'profile', type: 'schema' },
          { name: 'gone', type: 'schema' },
        ] as never,
        [nsKey('gone')]: keyPage(['gone:1']).objects as never,
      },
      treeCursors: { [nsKey('gone')]: 'stale-cursor' },
      treeLoadedByKey: { [rootKey]: true, [nsKey('gone')]: true },
      expandedSchemas: new Set<string>(),
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ objects: [{ name: 'profile', type: 'schema' }], next_cursor: '' })) as unknown as typeof fetch
    )

    await useWorkspaceStore.getState().refreshTree(CONN)

    expect(useWorkspaceStore.getState().treeItems[nsKey('gone')]).toBeUndefined()
    expect(useWorkspaceStore.getState().treeCursors[nsKey('gone')]).toBeUndefined()
  })

  it('does not let a slower earlier refresh overwrite a newer one', async () => {
    useWorkspaceStore.setState({
      treeItems: { [rootKey]: keyPage(['old']).objects as never },
      treeLoadedByKey: { [rootKey]: true },
    })
    const first = deferred<Response>()
    const second = deferred<Response>()
    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        call += 1
        return call === 1 ? first.promise : second.promise
      }) as unknown as typeof fetch
    )

    const refreshA = useWorkspaceStore.getState().refreshTree(CONN)
    await Promise.resolve()
    // Second refresh starts and finishes first.
    const refreshB = useWorkspaceStore.getState().refreshTree(CONN)
    second.resolve(jsonResponse(keyPage(['newest'])))
    await refreshB

    // Now the stale first refresh lands.
    first.resolve(jsonResponse(keyPage(['stale'])))
    await refreshA

    expect(names(rootKey)).toEqual(['newest'])
  })

  it('sends the selected cluster node with every paged request', async () => {
    useWorkspaceStore.setState({
      treeItems: {
        [rootKey]: [{ name: 'profile', type: 'schema' }] as never,
        [nsKey('profile')]: keyPage(['profile:1']).objects as never,
      },
      treeLoadedByKey: { [rootKey]: true, [nsKey('profile')]: true },
      expandedSchemas: new Set([nsKey('profile')]),
      selectedNodeByConnection: { [CONN]: '10.0.0.7:7001' },
    })
    const requested: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        requested.push(String(url))
        return jsonResponse(keyPage(['profile:1']))
      }) as unknown as typeof fetch
    )

    await useWorkspaceStore.getState().refreshTree(CONN)

    expect(requested.length).toBeGreaterThan(0)
    for (const url of requested) {
      expect(url).toContain('node=10.0.0.7%3A7001')
    }
  })

  it('marks only the refreshed connection as refreshing', async () => {
    useWorkspaceStore.setState({
      treeItems: { [rootKey]: keyPage(['profile:1']).objects as never },
      treeLoadedByKey: { [rootKey]: true },
    })
    const gate = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn(() => gate.promise) as unknown as typeof fetch)

    const refresh = useWorkspaceStore.getState().refreshTree(CONN)
    await Promise.resolve()

    expect(useWorkspaceStore.getState().treeRefreshingByConnection[CONN]).toBe(true)
    expect(useWorkspaceStore.getState().treeRefreshingByConnection['other-conn']).toBeUndefined()

    gate.resolve(jsonResponse(keyPage(['profile:1'])))
    await refresh
  })
})
