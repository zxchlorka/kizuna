import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  pruneDeadConnections,
  restoreWorkspace,
  syncWorkspaceWithConnections,
} from '@/lib/workspacePersistence'
import { useSqlConsoleStore } from '@/stores/sqlConsole'
import { useWorkspaceStore, type WorkspaceTab } from '@/stores/workspace'

const STORAGE_KEY = 'kizuna-workspace'

function createLocalStorageMock(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => store.clear(),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size
    },
  } as Storage
}

let localStorageMock: Storage
let addEventListenerSpy: ReturnType<typeof vi.fn>
let visibilityChangeCallback: (() => void) | undefined

function objectTab(id: string, connId: string): WorkspaceTab {
  return { kind: 'object', id, connId, object: 'users', label: 'users', objectType: 'table' }
}

function resetStores() {
  useWorkspaceStore.setState({
    tabs: [],
    activeTabId: null,
    activeTabByConnection: {},
    openConnectionIds: [],
    navigationHistory: [],
  })
  useSqlConsoleStore.setState({ tabs: {} })
}

beforeEach(() => {
  localStorageMock = createLocalStorageMock()
  visibilityChangeCallback = undefined
  addEventListenerSpy = vi.fn((event: string, cb: () => void) => {
    if (event === 'visibilitychange') {
      visibilityChangeCallback = cb
    }
  })
  vi.stubGlobal('window', { localStorage: localStorageMock })
  vi.stubGlobal('document', { addEventListener: addEventListenerSpy, visibilityState: 'hidden' })
  resetStores()
  // Fake timers in every test, not just the debounce ones: restoreWorkspace's
  // subscriptions stay wired across the whole file (module-level, by design —
  // see its own comment), so a state change in an earlier, non-debounce-
  // focused test would otherwise arm a REAL 500ms setTimeout that fires later,
  // in the background, against whatever localStorage mock happens to be
  // globally stubbed at that moment. Real timers are restored in afterEach,
  // which discards any still-pending fake timer without running it.
  vi.useFakeTimers()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// Declared first and alone: restoreWorkspace only ever wires the
// visibilitychange listener (and the store subscriptions) on its FIRST call in
// the module's lifetime (see the `wired` guard in workspacePersistence.ts) --
// intentional in production (one page, one wiring), but it means only the
// very first restoreWorkspace() call in this whole file sees a document stub
// whose addEventListener capture this test can observe. Every other test
// below calls restoreWorkspace() too (to (re)apply a persisted snapshot), but
// none of them depend on capturing that listener.
describe('visibilitychange flush', () => {
  it('flushes immediately on visibilitychange instead of waiting out the debounce', () => {
    restoreWorkspace()

    useWorkspaceStore.setState({ tabs: [{ kind: 'sql', id: 's2', connId: 'c1', label: 'SQL Console' }] })
    useSqlConsoleStore.getState().ensureTab('s2')

    const setItemSpy = vi.spyOn(localStorageMock, 'setItem')
    useSqlConsoleStore.getState().setEditorValue('s2', 'select 2')
    expect(setItemSpy).not.toHaveBeenCalled()

    expect(visibilityChangeCallback).toBeDefined()
    visibilityChangeCallback?.()

    expect(setItemSpy).toHaveBeenCalledTimes(1)
    const written = JSON.parse(setItemSpy.mock.calls[0][1] as string)
    expect(written.sqlDrafts.s2).toBe('select 2')
  })
})

describe('restoreWorkspace — loading', () => {
  it('leaves the store at defaults when nothing is persisted', () => {
    restoreWorkspace()
    const state = useWorkspaceStore.getState()
    expect(state.tabs).toEqual([])
    expect(state.activeTabId).toBeNull()
  })

  it('restores tabs, active tab/connection state, and SQL drafts from a valid snapshot', () => {
    const sqlTab: WorkspaceTab = { kind: 'sql', id: 'c1:sql:1', connId: 'c1', label: 'SQL Console' }
    localStorageMock.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        tabs: [objectTab('t1', 'c1'), sqlTab],
        activeTabId: 'c1:sql:1',
        activeTabByConnection: { c1: 'c1:sql:1' },
        openConnectionIds: ['c1'],
        sqlDrafts: { 'c1:sql:1': 'select * from users' },
      })
    )

    restoreWorkspace()

    const workspace = useWorkspaceStore.getState()
    expect(workspace.tabs.map((t) => t.id)).toEqual(['t1', 'c1:sql:1'])
    expect(workspace.activeTabId).toBe('c1:sql:1')
    expect(workspace.activeTabByConnection).toEqual({ c1: 'c1:sql:1' })
    expect(workspace.openConnectionIds).toEqual(['c1'])

    const sqlConsole = useSqlConsoleStore.getState()
    expect(sqlConsole.tabs['c1:sql:1'].editorValue).toBe('select * from users')
  })

  it('falls back to defaults on corrupt JSON instead of throwing', () => {
    localStorageMock.setItem(STORAGE_KEY, '{not valid json')

    expect(() => restoreWorkspace()).not.toThrow()
    expect(useWorkspaceStore.getState().tabs).toEqual([])
  })

  it('falls back to defaults when the schema version does not match', () => {
    localStorageMock.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        tabs: [objectTab('t1', 'c1')],
        activeTabId: 't1',
        activeTabByConnection: {},
        openConnectionIds: ['c1'],
        sqlDrafts: {},
      })
    )

    restoreWorkspace()

    expect(useWorkspaceStore.getState().tabs).toEqual([])
  })

  it('falls back to defaults when required fields are missing or malformed', () => {
    localStorageMock.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 1, tabs: 'not-an-array', activeTabId: null })
    )

    restoreWorkspace()

    expect(useWorkspaceStore.getState().tabs).toEqual([])
  })

  it('a value under the storage key that is not an object falls back to defaults', () => {
    localStorageMock.setItem(STORAGE_KEY, JSON.stringify('just a string'))

    expect(() => restoreWorkspace()).not.toThrow()
    expect(useWorkspaceStore.getState().tabs).toEqual([])
  })

  // A snapshot that only satisfies Array.isArray(tabs) used to be hydrated into
  // the store as-is, and the first tabPageId(tab) then threw on tab.anchorConnId.
  // That crash is persistent: the bad snapshot stays in localStorage, so every
  // reload crashes again until the user clears site data by hand.
  it.each([
    ['a null tab', { tabs: [null] }],
    ['a tab that is not an object', { tabs: ['nope'] }],
    ['a tab with an unknown kind', { tabs: [{ kind: 'mystery', id: 't', connId: 'c', label: 'L' }] }],
    ['a tab missing connId', { tabs: [{ kind: 'sql', id: 't', label: 'L' }] }],
    ['a tab with a non-string id', { tabs: [{ kind: 'sql', id: 7, connId: 'c', label: 'L' }] }],
    ['an object tab missing objectType', { tabs: [{ kind: 'object', id: 't', connId: 'c', label: 'L', object: 'o' }] }],
    ['a tab with a non-string anchorConnId', { tabs: [{ kind: 'sql', id: 't', connId: 'c', label: 'L', anchorConnId: 3 }] }],
    ['openConnectionIds holding a non-string', { openConnectionIds: [1] }],
    ['activeTabByConnection holding a non-string', { activeTabByConnection: { c: 5 } }],
    ['sqlDrafts holding a non-string', { sqlDrafts: { t: {} } }],
  ])('falls back to defaults on %s', (_name, override) => {
    localStorageMock.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        tabs: [],
        activeTabId: null,
        activeTabByConnection: {},
        openConnectionIds: [],
        sqlDrafts: {},
        ...override,
      })
    )

    expect(() => restoreWorkspace()).not.toThrow()
    expect(useWorkspaceStore.getState().tabs).toEqual([])
  })

  it('still restores a snapshot whose tabs are all well formed', () => {
    localStorageMock.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        tabs: [
          { kind: 'sql', id: 'sql-1', connId: 'c1', label: 'Query' },
          { kind: 'object', id: 'obj-1', connId: 'c1', label: 'users', object: 'public.users', objectType: 'table' },
          { kind: 'redis-cli', id: 'cli-1', connId: 'c2', label: 'CLI', anchorConnId: 'c1' },
        ],
        activeTabId: 'sql-1',
        activeTabByConnection: { c1: 'sql-1' },
        openConnectionIds: ['c1', 'c2'],
        sqlDrafts: { 'sql-1': 'select 1' },
      })
    )

    restoreWorkspace()

    expect(useWorkspaceStore.getState().tabs).toHaveLength(3)
    expect(useWorkspaceStore.getState().activeTabId).toBe('sql-1')
  })
})

describe('pruneDeadConnections', () => {
  it('drops tabs whose connection is missing, keeps tabs on live connections', () => {
    useWorkspaceStore.setState({
      tabs: [objectTab('t1', 'live'), objectTab('t2', 'dead')],
      openConnectionIds: ['live', 'dead'],
      activeTabId: 't2',
    })

    pruneDeadConnections(['live'])

    const state = useWorkspaceStore.getState()
    expect(state.tabs.map((t) => t.id)).toEqual(['t1'])
    expect(state.openConnectionIds).toEqual(['live'])
    // The active tab pointed at the pruned tab, so it must not dangle.
    expect(state.activeTabId).toBeNull()
  })

  it('keeps everything when all referenced connections are live', () => {
    useWorkspaceStore.setState({
      tabs: [objectTab('t1', 'live-a'), objectTab('t2', 'live-b')],
      openConnectionIds: ['live-a', 'live-b'],
    })

    pruneDeadConnections(['live-a', 'live-b'])

    expect(useWorkspaceStore.getState().tabs.map((t) => t.id)).toEqual(['t1', 't2'])
  })
})

// The prune is destructive and immediately re-persisted, so a wrong one is
// unrecoverable. These cover the two ways the connection list can look empty
// without every connection actually being gone.
describe('syncWorkspaceWithConnections — refusing to prune on bad input', () => {
  const restoredTabs = () => useWorkspaceStore.getState().tabs.map((t) => t.id)

  beforeEach(() => {
    useWorkspaceStore.setState({
      tabs: [objectTab('t1', 'c1'), objectTab('t2', 'c2')],
      openConnectionIds: ['c1', 'c2'],
    })
  })

  it('pruneDeadConnections itself wipes everything when handed an empty list', () => {
    // Not a wish, a warning: the raw prune has no opinion about *why* the list
    // is empty, which is exactly why callers must go through the guarded entry
    // point below rather than calling it directly.
    pruneDeadConnections([])

    expect(restoredTabs()).toEqual([])
  })

  it('keeps tabs when the connection fetch failed, even though loadedOnce is set', () => {
    // stores/connections.ts sets loadedOnce on the error path too, leaving
    // connections at []. A restarting backend must not wipe the session.
    syncWorkspaceWithConnections({ loadedOnce: true, error: 'Failed to fetch', connIds: [] })

    expect(restoredTabs()).toEqual(['t1', 't2'])
  })

  it('keeps tabs when the list is empty', () => {
    syncWorkspaceWithConnections({ loadedOnce: true, error: null, connIds: [] })

    expect(restoredTabs()).toEqual(['t1', 't2'])
  })

  it('keeps tabs before the connection list has loaded', () => {
    syncWorkspaceWithConnections({ loadedOnce: false, error: null, connIds: [] })

    expect(restoredTabs()).toEqual(['t1', 't2'])
  })

  it('prunes once a successful, non-empty list is available', () => {
    syncWorkspaceWithConnections({ loadedOnce: true, error: null, connIds: ['c1'] })

    expect(restoredTabs()).toEqual(['t1'])
  })
})

describe('debounced persistence', () => {
  it('coalesces a burst of rapid edits into a single write of the final value', () => {
    restoreWorkspace() // wires the subscriptions (idempotent to call again below)

    useWorkspaceStore.setState({ tabs: [{ kind: 'sql', id: 's1', connId: 'c1', label: 'SQL Console' }] })
    useSqlConsoleStore.getState().ensureTab('s1')

    const setItemSpy = vi.spyOn(localStorageMock, 'setItem')

    useSqlConsoleStore.getState().setEditorValue('s1', 'select 1')
    vi.advanceTimersByTime(100)
    useSqlConsoleStore.getState().setEditorValue('s1', 'select 1,')
    vi.advanceTimersByTime(100)
    useSqlConsoleStore.getState().setEditorValue('s1', 'select 1,2')

    // Still inside the 500ms debounce window from the last keystroke: nothing
    // written yet.
    expect(setItemSpy).not.toHaveBeenCalled()

    vi.advanceTimersByTime(500)

    expect(setItemSpy).toHaveBeenCalledTimes(1)
    const written = JSON.parse(setItemSpy.mock.calls[0][1] as string)
    expect(written.sqlDrafts.s1).toBe('select 1,2')
  })
})
