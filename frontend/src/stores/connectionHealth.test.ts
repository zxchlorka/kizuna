import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useConnectionHealthStore, type ConnectionHealthEntry } from '@/stores/connectionHealth'

const STORAGE_KEY = 'kizuna-connection-health'

function makeLocalStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  }
}

function entry(status: ConnectionHealthEntry['status'] = 'healthy'): ConnectionHealthEntry {
  return { status, checking: false, updatedAt: Date.now(), latencyMs: 4, error: null }
}

let localStorageMock: ReturnType<typeof makeLocalStorage>

beforeEach(() => {
  localStorageMock = makeLocalStorage()
  vi.stubGlobal('window', { localStorage: localStorageMock })
  useConnectionHealthStore.setState({ hydrated: false, entries: {} })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// The health cache is written to localStorage and pruned against the connection
// list. Because prune deletes AND persists in one step, a prune against a list
// that is merely unavailable — not actually empty — destroys the cache on disk,
// which no later render can undo.
describe('connectionHealth.prune', () => {
  const seed = () => {
    useConnectionHealthStore.setState({
      hydrated: true,
      entries: { a: entry(), b: entry('unhealthy') },
    })
  }

  it('refuses an empty list instead of treating it as "delete everything"', () => {
    seed()

    useConnectionHealthStore.getState().prune([])

    expect(Object.keys(useConnectionHealthStore.getState().entries).sort()).toEqual(['a', 'b'])
  })

  it('does not touch persisted storage when it refuses', () => {
    seed()
    const onDisk = JSON.stringify({ a: entry() })
    localStorageMock.setItem(STORAGE_KEY, onDisk)

    useConnectionHealthStore.getState().prune([])

    expect(localStorageMock.getItem(STORAGE_KEY)).toBe(onDisk)
  })

  it('still drops entries for connections missing from a real list', () => {
    seed()

    useConnectionHealthStore.getState().prune(['a'])

    expect(Object.keys(useConnectionHealthStore.getState().entries)).toEqual(['a'])
  })

  it('persists the pruned result so the drop survives a reload', () => {
    seed()

    useConnectionHealthStore.getState().prune(['b'])

    const persisted = JSON.parse(localStorageMock.getItem(STORAGE_KEY) ?? '{}') as Record<string, unknown>
    expect(Object.keys(persisted)).toEqual(['b'])
  })
})

// Regression guard for the page-load sequence: the list page hydrates the cache
// and then prunes it in a later effect, at a point where the connection list has
// not arrived yet. That combination silently wiped the cache on every single
// load, which in turn made every connection look stale and get re-probed.
describe('hydrate followed by an early prune', () => {
  it('keeps hydrated entries when the connection list is not available yet', () => {
    localStorageMock.setItem(STORAGE_KEY, JSON.stringify({ a: entry(), b: entry() }))

    useConnectionHealthStore.getState().hydrate()
    expect(Object.keys(useConnectionHealthStore.getState().entries).sort()).toEqual(['a', 'b'])

    // What the mount-time effect used to do before the list resolved.
    useConnectionHealthStore.getState().prune([])

    expect(Object.keys(useConnectionHealthStore.getState().entries).sort()).toEqual(['a', 'b'])
    const persisted = JSON.parse(localStorageMock.getItem(STORAGE_KEY) ?? '{}') as Record<string, unknown>
    expect(Object.keys(persisted).sort()).toEqual(['a', 'b'])
  })
})
