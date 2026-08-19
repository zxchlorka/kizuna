import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_SCAN_MATCHES, useKafkaStore } from '@/stores/kafka'

// These tests drive the REAL store against a mocked fetch to verify the
// network-level acceptance criteria that a pure-function test cannot: that
// "Filter loaded" issues zero requests, and that "Cancel" aborts the actual
// in-flight HTTP request (signal.aborted) rather than just stopping a loop.
//
// fetchWithTimeout uses window.setTimeout/clearTimeout; point window at
// globalThis (real timers) for the node test environment.
vi.stubGlobal('window', globalThis)

const authDoc = '{"src":{"event_data":{"events":[{"name":"Auth"}]}}}'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function scanRow(partition: number, offset: number) {
  return { partition, offset, timestamp: '', key: '', value: authDoc, format: 'json' }
}

beforeEach(() => {
  useKafkaStore.setState({ tabs: {} })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.stubGlobal('window', globalThis)
})

describe('Filter loaded — client-side only', () => {
  it('setLoadedFilter / clearLoadedFilter never touch the network', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    useKafkaStore.getState().setLoadedFilter('tab-filter', [{ field: 'src.event_data.events[].name', value: 'Auth', op: 'eq' }])
    let tab = useKafkaStore.getState().tabs['tab-filter']
    expect(tab.filterActive).toBe(true)
    expect(tab.filterConditions[0].field).toBe('src.event_data.events[].name')

    useKafkaStore.getState().clearLoadedFilter('tab-filter')
    tab = useKafkaStore.getState().tabs['tab-filter']
    expect(tab.filterActive).toBe(false)
    expect(tab.filterConditions).toEqual([])

    // The whole point of "Filter loaded": zero requests, and the cursor state
    // (nextCursor/hasMore) is never mutated by filtering.
    expect(fetchMock).not.toHaveBeenCalled()
    expect(tab.nextCursor).toBeNull()
  })
})

describe('Search topic — backend scan', () => {
  it('sends match_field/match_value and populates matches + scanned', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(
        jsonResponse({
          columns: [],
          rows: [scanRow(0, 7)],
          total: 1,
          has_more: false,
          meta: { scanning: true, scanned: 40, matched: 1, has_older: true, next_before_offsets: { '0': 5 } },
        })
      )
    )
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    await useKafkaStore.getState().searchTopic('c1', 'topic', 'tab-scan', [{ field: 'src.event_data.events[].name', value: 'Auth', op: 'eq' }])

    const tab = useKafkaStore.getState().tabs['tab-scan']
    expect(tab.searchActive).toBe(true)
    expect(tab.messages).toHaveLength(1)
    expect(tab.scanned).toBe(40)
    expect(tab.hasMore).toBe(true)
    expect(tab.scanning).toBe(false)

    const calledUrl = decodeURIComponent(String(fetchMock.mock.calls[0][0]))
    expect(calledUrl).toContain('match_field')
    expect(calledUrl).toContain('match_value')
  })

  // A key condition carries no field, and a rule that demanded one dropped it
  // before it ever reached a request — the filter simply did nothing.
  it('a key condition is sent with no field of its own', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(
        jsonResponse({ columns: [], rows: [], total: 0, has_more: false, meta: { scanned: 5, matched: 0 } })
      )
    )
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    await useKafkaStore
      .getState()
      .searchTopic('c1', 'topic', 'tab-key', [{ field: '', value: 'user-42', op: 'eq', target: 'key' }])

    const calledUrl = decodeURIComponent(String(fetchMock.mock.calls[0][0]))
    expect(calledUrl).toContain('"match_target","op":"eq","value":"key"')
    expect(calledUrl).toContain('"match_value","op":"eq","value":"user-42"')
    expect(calledUrl).not.toContain('match_field')
  })

  // Switching a condition from the payload to the key leaves the old path in
  // the box; it must not ride along as a field the key does not have.
  it('drops a leftover path when the condition moved to the key', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(
        jsonResponse({ columns: [], rows: [], total: 0, has_more: false, meta: { scanned: 1, matched: 0 } })
      )
    )
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    await useKafkaStore
      .getState()
      .searchTopic('c1', 'topic', 'tab-stale', [{ field: 'events[].name', value: 'user-42', op: 'eq', target: 'key' }])

    expect(decodeURIComponent(String(fetchMock.mock.calls[0][0]))).not.toContain('events[].name')
  })

  it('scanMore continues from the prior cursor and accumulates scanned + matches', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          columns: [],
          rows: [scanRow(0, 7)],
          total: 1,
          has_more: false,
          meta: { scanning: true, scanned: 40, matched: 1, has_older: true, next_before_offsets: { '0': 5 } },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          columns: [],
          rows: [scanRow(0, 3)],
          total: 1,
          has_more: false,
          meta: { scanning: true, scanned: 30, matched: 1, has_older: false, next_before_offsets: {} },
        })
      )
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    await useKafkaStore.getState().searchTopic('c1', 'topic', 'tab-more', [{ field: 'a.b', value: 'x', op: 'eq' }])
    await useKafkaStore.getState().scanMore('c1', 'topic', 'tab-more')

    const tab = useKafkaStore.getState().tabs['tab-more']
    expect(tab.messages).toHaveLength(2)
    expect(tab.scanned).toBe(70)
    expect(tab.hasMore).toBe(false)

    // The continuation carried the first step's cursor.
    const secondCall = String(fetchMock.mock.calls[1][0])
    const filters = JSON.parse(new URL(secondCall, 'http://localhost').searchParams.get('filters') ?? '[]') as Array<{
      column: string
      value: string
    }>
    const beforeOffsets = filters.find((f) => f.column === 'before_offsets')
    expect(beforeOffsets?.value).toBe('{"0":5}')
  })

  it('a step reporting partial_scan keeps its matches and flags scanPartial', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          columns: [],
          rows: [scanRow(0, 7)],
          total: 1,
          has_more: false,
          meta: { scanning: true, scanned: 5000, matched: 1, has_older: true, partial_scan: true, next_before_offsets: { '0': 5 } },
        })
      )
    )
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    await useKafkaStore.getState().searchTopic('c1', 'topic', 'tab-partial', [{ field: 'a.b', value: 'x', op: 'eq' }])

    const tab = useKafkaStore.getState().tabs['tab-partial']
    expect(tab.scanPartial).toBe(true)
    expect(tab.messages).toHaveLength(1) // step matches preserved
    expect(tab.hasMore).toBe(true)
  })
})

describe('Cancel aborts the in-flight request', () => {
  it('cancelScan aborts the actual fetch signal and preserves prior matches', async () => {
    let capturedSignal: AbortSignal | undefined
    const fetchMock = vi
      .fn()
      // First step resolves with one match + a cursor.
      .mockImplementationOnce(() =>
        Promise.resolve(
          jsonResponse({
            columns: [],
            rows: [scanRow(0, 7)],
            total: 1,
            has_more: false,
            meta: { scanning: true, scanned: 40, matched: 1, has_older: true, next_before_offsets: { '0': 5 } },
          })
        )
      )
      // Second step (scanMore) hangs until its signal aborts.
      .mockImplementationOnce(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            capturedSignal = init?.signal ?? undefined
            init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
          })
      )
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    await useKafkaStore.getState().searchTopic('c1', 'topic', 'tab-cancel', [{ field: 'a.b', value: 'x', op: 'eq' }])
    expect(useKafkaStore.getState().tabs['tab-cancel'].messages).toHaveLength(1)

    // Kick off a second step but don't await it — it hangs on the mock above.
    const pending = useKafkaStore.getState().scanMore('c1', 'topic', 'tab-cancel')
    await Promise.resolve()
    expect(useKafkaStore.getState().tabs['tab-cancel'].scanning).toBe(true)
    expect(capturedSignal).toBeDefined()
    expect(capturedSignal!.aborted).toBe(false)

    useKafkaStore.getState().cancelScan('tab-cancel')

    // The underlying HTTP request was actually aborted, not merely ignored.
    expect(capturedSignal!.aborted).toBe(true)

    await pending
    const tab = useKafkaStore.getState().tabs['tab-cancel']
    expect(tab.scanning).toBe(false)
    // Matches found before the cancel survive.
    expect(tab.messages).toHaveLength(1)
    expect(tab.messagesError).toBeNull()
  })

  it('a superseded step cannot write into the search that replaced it', async () => {
    let releaseStale: ((res: Response) => void) | undefined
    const fetchMock = vi
      .fn()
      // Step 1: the original search.
      .mockImplementationOnce(() =>
        Promise.resolve(
          jsonResponse({
            columns: [],
            rows: [scanRow(0, 7)],
            total: 1,
            has_more: false,
            meta: { scanning: true, scanned: 40, matched: 1, has_older: true, next_before_offsets: { '0': 5 } },
          })
        )
      )
      // Step 2: hangs, and stays hanging past the cancel. Resolving it by hand
      // below is how the test reproduces a response that lands only after the
      // user has already started a different search — the ordering the identity
      // guard exists for.
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (releaseStale = resolve)))
      // Step 3: the replacement search.
      .mockImplementationOnce(() =>
        Promise.resolve(
          jsonResponse({
            columns: [],
            rows: [scanRow(1, 99)],
            total: 1,
            has_more: false,
            meta: { scanning: true, scanned: 10, matched: 1, has_older: false, next_before_offsets: {} },
          })
        )
      )
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    await useKafkaStore.getState().searchTopic('c1', 'topic', 'tab-stale', [{ field: 'a.b', value: 'x', op: 'eq' }])
    const stale = useKafkaStore.getState().scanMore('c1', 'topic', 'tab-stale')
    await Promise.resolve()

    useKafkaStore.getState().cancelScan('tab-stale')
    await useKafkaStore.getState().searchTopic('c1', 'topic', 'tab-stale', [{ field: 'a.b', value: 'y', op: 'eq' }])

    const afterReplacement = useKafkaStore.getState().tabs['tab-stale']
    expect(afterReplacement.messages).toHaveLength(1)
    expect(afterReplacement.scanned).toBe(10)

    // The abandoned step finally answers. Its rows belong to a search the user
    // has already left, so none of them may appear, and it must not touch the
    // spinner or counters of the search now on screen.
    releaseStale?.(
      jsonResponse({
        columns: [],
        rows: [scanRow(2, 123)],
        total: 1,
        has_more: true,
        meta: { scanning: true, scanned: 999, matched: 1, has_older: true, next_before_offsets: { '2': 1 } },
      })
    )
    await stale

    const tab = useKafkaStore.getState().tabs['tab-stale']
    expect(tab.messages).toHaveLength(1)
    expect(tab.messages[0].offset).toBe(99)
    expect(tab.scanned).toBe(10)
    expect(tab.scanning).toBe(false)
  })
})

describe('Search all — ceiling on accumulated matches', () => {
  // Each step returns a fresh block of matches and always claims there is more,
  // which is what a broad predicate on a big topic looks like. Without a ceiling
  // this loop only ends when the log does.
  function blockOfMatches(startOffset: number, count: number) {
    return Array.from({ length: count }, (_, i) => scanRow(0, startOffset + i))
  }

  it('stops Search all at MAX_SCAN_MATCHES instead of growing without bound', async () => {
    let nextOffset = 0
    let cursor = 0
    const fetchMock = vi.fn(() => {
      const rows = blockOfMatches(nextOffset, 3000)
      nextOffset += 3000
      cursor += 1
      return Promise.resolve(
        jsonResponse({
          columns: [],
          rows,
          total: rows.length,
          has_more: true,
          meta: { scanning: true, scanned: 5000, matched: rows.length, has_older: true, next_before_offsets: { '0': cursor } },
        })
      )
    })
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    await useKafkaStore.getState().searchTopic('c1', 'topic', 'tab-cap', [{ field: 'a.b', value: 'x', op: 'eq' }])
    expect(useKafkaStore.getState().tabs['tab-cap'].messages).toHaveLength(3000)
    expect(useKafkaStore.getState().tabs['tab-cap'].scanLimitReached).toBe(false)

    await useKafkaStore.getState().scanAll('c1', 'topic', 'tab-cap')

    const tab = useKafkaStore.getState().tabs['tab-cap']
    expect(tab.messages).toHaveLength(MAX_SCAN_MATCHES)
    expect(tab.scanLimitReached).toBe(true)
    expect(tab.deepScanning).toBe(false)
    // One step for the search, one more before the ceiling stopped the loop —
    // the log still reports has_older, so only the ceiling can end this.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  // Landing exactly on the ceiling is ambiguous on its own: it is a truncated
  // result only if there was more to read. With the log exhausted the result is
  // complete, and calling it truncated also hides the "reached end/beginning"
  // marker in the browser, so the reader cannot tell a full answer from a cut one.
  it('does not call an exactly-full result truncated when the log is exhausted', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          columns: [],
          rows: blockOfMatches(0, MAX_SCAN_MATCHES),
          total: MAX_SCAN_MATCHES,
          has_more: false,
          meta: { scanning: false, scanned: 9000, matched: MAX_SCAN_MATCHES, has_older: false, next_before_offsets: {} },
        })
      )
    )
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    await useKafkaStore.getState().searchTopic('c1', 'topic', 'tab-exact', [{ field: 'a.b', value: 'x', op: 'eq' }])

    const tab = useKafkaStore.getState().tabs['tab-exact']
    expect(tab.messages).toHaveLength(MAX_SCAN_MATCHES)
    expect(tab.hasMore).toBe(false)
    expect(tab.scanLimitReached).toBe(false)
  })

  it('still flags the ceiling on an exactly-full page that has more to come', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          columns: [],
          rows: blockOfMatches(0, MAX_SCAN_MATCHES),
          total: MAX_SCAN_MATCHES,
          has_more: true,
          meta: { scanning: true, scanned: 9000, matched: MAX_SCAN_MATCHES, has_older: true, next_before_offsets: { '0': 1 } },
        })
      )
    )
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    await useKafkaStore.getState().searchTopic('c1', 'topic', 'tab-exact-more', [{ field: 'a.b', value: 'x', op: 'eq' }])

    const tab = useKafkaStore.getState().tabs['tab-exact-more']
    expect(tab.messages).toHaveLength(MAX_SCAN_MATCHES)
    expect(tab.scanLimitReached).toBe(true)
  })

  it('a fresh search clears the ceiling flag', async () => {
    useKafkaStore.setState({
      tabs: {
        'tab-reset': {
          ...useKafkaStore.getState().tabs['tab-reset'],
          scanLimitReached: true,
        } as never,
      },
    })
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          columns: [],
          rows: [scanRow(0, 1)],
          total: 1,
          has_more: false,
          meta: { scanning: true, scanned: 10, matched: 1, has_older: false, next_before_offsets: {} },
        })
      )
    )
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    await useKafkaStore.getState().searchTopic('c1', 'topic', 'tab-reset', [{ field: 'a.b', value: 'x', op: 'eq' }])

    expect(useKafkaStore.getState().tabs['tab-reset'].scanLimitReached).toBe(false)
  })
})

describe('loadInitialMessages — mount-path guard against search clobbering', () => {
  it('does NOT browse-overwrite an active search session when the tab remounts', async () => {
    // First: run a search so the tab holds scan matches + searchActive.
    const searchFetch = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          columns: [],
          rows: [scanRow(0, 7)],
          total: 1,
          has_more: false,
          meta: { scanning: true, scanned: 40, matched: 1, has_older: true, next_before_offsets: { '0': 5 } },
        })
      )
    )
    vi.stubGlobal('fetch', searchFetch as unknown as typeof fetch)
    await useKafkaStore.getState().searchTopic('c1', 'topic', 'tab-remount', [{ field: 'a.b', value: 'x', op: 'eq' }])

    const afterSearch = useKafkaStore.getState().tabs['tab-remount']
    expect(afterSearch.searchActive).toBe(true)
    expect(afterSearch.messages).toHaveLength(1)
    expect(afterSearch.scanned).toBe(40)
    expect(afterSearch.nextCursor).toEqual({ '0': 5 })

    // Now simulate KafkaTopicView remounting (tab-switch-away-and-back): the
    // mount effect fires loadInitialMessages for the same tab. It must issue NO
    // browse request and leave messages/scanned/searchActive/cursor intact — the
    // reviewer's deterministic case #2.
    const browseFetch = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          columns: [],
          rows: [scanRow(0, 9), scanRow(0, 8)],
          total: 2,
          has_more: false,
          meta: { has_older: false, partitions_total: 1, partitions_completed: 1, messages_returned: 2 },
        })
      )
    )
    vi.stubGlobal('fetch', browseFetch as unknown as typeof fetch)

    await useKafkaStore.getState().loadInitialMessages('c1', 'topic', 'tab-remount')

    expect(browseFetch).not.toHaveBeenCalled()
    const tab = useKafkaStore.getState().tabs['tab-remount']
    expect(tab.searchActive).toBe(true)
    expect(tab.messages).toHaveLength(1)
    expect(tab.messages[0].offset).toBe(7)
    expect(tab.scanned).toBe(40)
    expect(tab.nextCursor).toEqual({ '0': 5 })
  })

  it('loads the browse page for a brand-new tab with no active search', async () => {
    const browseFetch = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(
        jsonResponse({
          columns: [],
          rows: [scanRow(0, 9), scanRow(0, 8)],
          total: 2,
          has_more: false,
          meta: { has_older: false, partitions_total: 1, partitions_completed: 1, messages_returned: 2 },
        })
      )
    )
    vi.stubGlobal('fetch', browseFetch as unknown as typeof fetch)

    await useKafkaStore.getState().loadInitialMessages('c1', 'topic', 'tab-new')

    expect(browseFetch).toHaveBeenCalledTimes(1)
    const browseUrl = decodeURIComponent(String(browseFetch.mock.calls[0][0]))
    expect(browseUrl).not.toContain('match_field')
    const tab = useKafkaStore.getState().tabs['tab-new']
    expect(tab.searchActive).toBe(false)
    expect(tab.messages).toHaveLength(2)
  })
})

describe('Refresh is search-aware (settled-search clobber guard)', () => {
  it('re-runs the current search from the top instead of browse-overwriting a settled search', async () => {
    // Reproduces the reviewer's scenario: an active, SETTLED search (matches
    // loaded, searchActive:true, scanning:false), then an explicit Refresh (both
    // the toolbar and header buttons route through refreshMessages). The old
    // browse-only fetchMessages would have replaced the scan rows/cursor with
    // unrelated browse data while leaving searchActive/scanned stale. It must now
    // RE-RUN the search from the top.
    const fetchMock = vi
      .fn()
      // Initial search step — settles (scanning:false) with one match + a cursor.
      .mockResolvedValueOnce(
        jsonResponse({
          columns: [],
          rows: [scanRow(0, 7)],
          total: 1,
          has_more: false,
          meta: { scanning: true, scanned: 40, matched: 1, has_older: true, next_before_offsets: { '0': 5 } },
        })
      )
      // The Refresh must issue a fresh FIRST search step (distinct rows/cursor so
      // we can prove it re-scanned rather than reusing stale state or browsing).
      .mockResolvedValueOnce(
        jsonResponse({
          columns: [],
          rows: [scanRow(0, 6)],
          total: 1,
          has_more: false,
          meta: { scanning: true, scanned: 25, matched: 1, has_older: true, next_before_offsets: { '0': 4 } },
        })
      )
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    await useKafkaStore.getState().searchTopic('c1', 'topic', 'tab-refresh-search', [{ field: 'src.event_data.events[].name', value: 'Auth', op: 'eq' }])

    const settled = useKafkaStore.getState().tabs['tab-refresh-search']
    expect(settled.searchActive).toBe(true)
    expect(settled.scanning).toBe(false) // settled, not mid-scan
    expect(settled.messages).toHaveLength(1)
    expect(settled.scanned).toBe(40)
    expect(settled.nextCursor).toEqual({ '0': 5 })

    await useKafkaStore.getState().refreshMessages('c1', 'topic', 'tab-refresh-search')

    // The Refresh re-ran the SAME search (match_field/value carried), never a
    // browse fetch.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const refreshUrl = decodeURIComponent(String(fetchMock.mock.calls[1][0]))
    expect(refreshUrl).toContain('match_field')
    expect(refreshUrl).toContain('match_value')

    const tab = useKafkaStore.getState().tabs['tab-refresh-search']
    expect(tab.searchActive).toBe(true)
    // Fresh first step replaced the rows/cursor/scanned (reset). The header's
    // "Scanned N · M matches" now describes THIS re-run, not a stale count sitting
    // over unrelated browse rows — i.e. no silent browse corruption.
    expect(tab.messages).toHaveLength(1)
    expect(tab.messages[0].offset).toBe(6)
    expect(tab.scanned).toBe(25)
    expect(tab.nextCursor).toEqual({ '0': 4 })
  })

  it('browse-refreshes (no match filter) when no search is active — unchanged', async () => {
    const browseFetch = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(
        jsonResponse({
          columns: [],
          rows: [scanRow(0, 9), scanRow(0, 8)],
          total: 2,
          has_more: false,
          meta: { has_older: false, partitions_total: 1, partitions_completed: 1, messages_returned: 2 },
        })
      )
    )
    vi.stubGlobal('fetch', browseFetch as unknown as typeof fetch)

    // Seed a plain browse tab (searchActive:false) via the initial load.
    await useKafkaStore.getState().loadInitialMessages('c1', 'topic', 'tab-refresh-browse')
    expect(useKafkaStore.getState().tabs['tab-refresh-browse'].searchActive).toBe(false)

    await useKafkaStore.getState().refreshMessages('c1', 'topic', 'tab-refresh-browse')

    // Refresh on a browse tab behaves exactly as before: a browse fetch with no
    // match filter.
    expect(browseFetch).toHaveBeenCalledTimes(2)
    const refreshUrl = decodeURIComponent(String(browseFetch.mock.calls[1][0]))
    expect(refreshUrl).not.toContain('match_field')
    const tab = useKafkaStore.getState().tabs['tab-refresh-browse']
    expect(tab.searchActive).toBe(false)
    expect(tab.messages).toHaveLength(2)
  })
})

describe('Clearing a search returns to browse', () => {
  it('clearSearch reloads a browse page with no match filter', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          columns: [],
          rows: [scanRow(0, 7)],
          total: 1,
          has_more: false,
          meta: { scanning: true, scanned: 40, matched: 1, has_older: true, next_before_offsets: { '0': 5 } },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          columns: [],
          rows: [scanRow(0, 9), scanRow(0, 8)],
          total: 2,
          has_more: false,
          meta: { has_older: false, partitions_total: 1, partitions_completed: 1, messages_returned: 2 },
        })
      )
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    await useKafkaStore.getState().searchTopic('c1', 'topic', 'tab-clear', [{ field: 'a.b', value: 'x', op: 'eq' }])
    await useKafkaStore.getState().clearSearch('c1', 'topic', 'tab-clear')

    const tab = useKafkaStore.getState().tabs['tab-clear']
    expect(tab.searchActive).toBe(false)
    expect(tab.scanned).toBe(0)
    expect(tab.messages).toHaveLength(2)

    const browseUrl = decodeURIComponent(String(fetchMock.mock.calls[1][0]))
    expect(browseUrl).not.toContain('match_field')
  })
})

// A topic deleted and recreated under the same name is a NEW topic: its offsets
// restart, and the rows already on screen belong to an incarnation whose records
// no longer exist. The backend signals this with meta.cursor_reset after its
// purge-and-retry, and "Load older" must then REPLACE the page instead of
// appending to it — otherwise the table shows a mix of two topics whose
// partition/offset identities overlap but mean different records.
describe('Load older — topic recreated mid-session', () => {
  it('replaces the loaded page when the backend reports cursor_reset', async () => {
    const oldRow = { partition: 0, offset: 5, timestamp: '', key: '', value: '{"generation":"A"}', format: 'json' }
    const newRow = { partition: 0, offset: 1, timestamp: '', key: '', value: '{"generation":"B"}', format: 'json' }

    useKafkaStore.setState({
      tabs: {
        'tab-recreate': {
          ...useKafkaStore.getState().tabs['tab-recreate'],
          messages: [oldRow],
          hasMore: true,
          nextCursor: { '0': 5 },
          loadingOlder: false,
          messagesError: null,
        },
      },
    } as never)

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          columns: [],
          rows: [newRow],
          total: 1,
          has_more: false,
          meta: { cursor_reset: true, has_older: false, partitions_total: 1, partitions_completed: 1 },
        })
      ) as unknown as typeof fetch
    )

    await useKafkaStore.getState().fetchOlderMessages('conn-1', 'orders', 'tab-recreate')

    const tab = useKafkaStore.getState().tabs['tab-recreate']
    expect(tab.messages).toEqual([newRow])
  })

  it('still appends when the topic is unchanged', async () => {
    const first = { partition: 0, offset: 5, timestamp: '', key: '', value: '{"n":5}', format: 'json' }
    const older = { partition: 0, offset: 4, timestamp: '', key: '', value: '{"n":4}', format: 'json' }

    useKafkaStore.setState({
      tabs: {
        'tab-normal': {
          ...useKafkaStore.getState().tabs['tab-normal'],
          messages: [first],
          hasMore: true,
          nextCursor: { '0': 5 },
          loadingOlder: false,
          messagesError: null,
        },
      },
    } as never)

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          columns: [],
          rows: [older],
          total: 2,
          has_more: false,
          meta: { has_older: false, partitions_total: 1, partitions_completed: 1 },
        })
      ) as unknown as typeof fetch
    )

    await useKafkaStore.getState().fetchOlderMessages('conn-1', 'orders', 'tab-normal')

    expect(useKafkaStore.getState().tabs['tab-normal'].messages).toEqual([first, older])
  })
})

// A seek narrows WHICH PART of the log is read; a field search narrows WHICH of
// those messages are shown. The two are meant to compose, so setting a seek must
// keep an active search running (re-anchored) rather than dropping it, and the
// scan request must carry both filter sets.
describe('Seek — browse anchor', () => {
  function filtersOf(fetchMock: ReturnType<typeof vi.fn>, call = 0): Array<{ column: string; value: string }> {
    const url = String(fetchMock.mock.calls[call][0])
    const raw = new URL(url, 'http://localhost').searchParams.get('filters')
    return raw ? JSON.parse(raw) : []
  }

  it('sends from_timestamp alongside an active search and keeps the search alive', async () => {
    useKafkaStore.setState({
      tabs: {
        'tab-seek': {
          ...useKafkaStore.getState().tabs['tab-seek'],
          searchActive: true,
          searchConditions: [{ field: 'src.event_data.events[].name', value: 'Auth', op: 'eq' }],
          searchMode: 'and',
          messages: [scanRow(0, 9)],
        },
      },
    } as never)

    const fetchMock = vi.fn(async () =>
      jsonResponse({
        columns: [],
        rows: [scanRow(0, 3)],
        total: 1,
        has_more: false,
        meta: { scanning: true, scanned: 1, matched: 1, has_older: false },
      })
    )
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    await useKafkaStore
      .getState()
      .setSeek('conn-1', 'orders', 'tab-seek', { offset: '', timestamp: '2026-07-27T08:41:45.000Z' })

    const filters = filtersOf(fetchMock)
    expect(filters).toEqual(
      expect.arrayContaining([
        { column: 'from_timestamp', op: 'eq', value: '2026-07-27T08:41:45.000Z' },
        { column: 'match_field', op: 'eq', value: 'src.event_data.events[].name' },
      ])
    )

    const tab = useKafkaStore.getState().tabs['tab-seek']
    expect(tab.searchActive).toBe(true)
    expect(tab.seekTimestamp).toBe('2026-07-27T08:41:45.000Z')
  })

  it('keeps an offset seek when widening back to all partitions', async () => {
    useKafkaStore.setState({
      tabs: {
        'tab-widen': {
          ...useKafkaStore.getState().tabs['tab-widen'],
          partitionFilter: 3,
          seekOffset: '500',
          seekTimestamp: '',
        },
      },
    } as never)

    const fetchMock = vi.fn(async () =>
      jsonResponse({ columns: [], rows: [], total: 0, has_more: false, meta: { has_older: false } })
    )
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    await useKafkaStore.getState().setPartitionFilter('conn-1', 'orders', 'tab-widen', null)

    // An offset applies to every scoped partition: it lands inside the ones
    // whose range contains it and the rest contribute nothing, which the
    // partitions_windowed readout reports. So widening keeps the anchor rather
    // than silently discarding what the user asked for.
    expect(useKafkaStore.getState().tabs['tab-widen'].seekOffset).toBe('500')
    expect(filtersOf(fetchMock)).toEqual(
      expect.arrayContaining([{ column: 'from_offset', op: 'eq', value: '500' }])
    )
  })
})

// The two directions carry opposite cursors, so the store must send the field
// matching the order it asked for and read back the matching meta pair. Mixing
// them would silently build a window from a bound that means the other thing.
describe('Oldest-first direction', () => {
  function filtersOf(fetchMock: ReturnType<typeof vi.fn>, call = 0): Array<{ column: string; value: string }> {
    const url = String(fetchMock.mock.calls[call][0])
    const raw = new URL(url, 'http://localhost').searchParams.get('filters')
    return raw ? JSON.parse(raw) : []
  }

  it('requests order=oldest and stores has_newer / next_after_offsets', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        columns: [],
        rows: [scanRow(0, 1)],
        total: 1,
        has_more: true,
        // The newest-first pair is deliberately present and WRONG here: reading
        // it would report "nothing more" for a direction that has plenty.
        meta: { has_newer: true, next_after_offsets: { '0': 2 }, has_older: false },
      })
    )
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    await useKafkaStore.getState().setDirection('conn-1', 'orders', 'tab-oldest', 'oldest')

    expect(filtersOf(fetchMock)).toEqual(
      expect.arrayContaining([{ column: 'order', op: 'eq', value: 'oldest' }])
    )

    const tab = useKafkaStore.getState().tabs['tab-oldest']
    expect(tab.direction).toBe('oldest')
    expect(tab.hasMore).toBe(true)
    expect(tab.nextCursor).toEqual({ '0': 2 })
  })

  it('pages with after_offsets, never before_offsets', async () => {
    useKafkaStore.setState({
      tabs: {
        'tab-page': {
          ...useKafkaStore.getState().tabs['tab-page'],
          direction: 'oldest',
          messages: [scanRow(0, 1)],
          hasMore: true,
          nextCursor: { '0': 2 },
          loadingOlder: false,
          messagesError: null,
        },
      },
    } as never)

    const fetchMock = vi.fn(async () =>
      jsonResponse({
        columns: [],
        rows: [scanRow(0, 2)],
        total: 2,
        has_more: false,
        meta: { has_newer: false },
      })
    )
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    await useKafkaStore.getState().fetchOlderMessages('conn-1', 'orders', 'tab-page')

    const filters = filtersOf(fetchMock)
    expect(filters).toEqual(
      expect.arrayContaining([{ column: 'after_offsets', op: 'eq', value: '{"0":2}' }])
    )
    expect(filters.some((filter) => filter.column === 'before_offsets')).toBe(false)

    // Paging appends in the direction of travel, exactly as newest-first does.
    expect(useKafkaStore.getState().tabs['tab-page'].messages).toEqual([scanRow(0, 1), scanRow(0, 2)])
  })

  it('drops the page and cursor when the direction flips', async () => {
    useKafkaStore.setState({
      tabs: {
        'tab-flip': {
          ...useKafkaStore.getState().tabs['tab-flip'],
          direction: 'newest',
          messages: [scanRow(0, 9)],
          hasMore: true,
          nextCursor: { '0': 9 },
        },
      },
    } as never)

    const fetchMock = vi.fn(async () =>
      jsonResponse({ columns: [], rows: [], total: 0, has_more: false, meta: { has_newer: false } })
    )
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    await useKafkaStore.getState().setDirection('conn-1', 'orders', 'tab-flip', 'oldest')

    // The old cursor belongs to the old direction and must not be carried over.
    expect(filtersOf(fetchMock).some((filter) => filter.column.endsWith('_offsets'))).toBe(false)
    expect(useKafkaStore.getState().tabs['tab-flip'].messages).toEqual([])
  })
})

describe('scanAll — автоцикл до начала лога', () => {
  // Страница скана: сколько прочитано, сколько совпало, есть ли ещё старее.
  function scanPage(scanned: number, matches: number[], hasOlder: boolean, cursor: number) {
    return jsonResponse({
      columns: [],
      rows: matches.map((offset) => scanRow(0, offset)),
      total: matches.length,
      has_more: false,
      meta: {
        scanning: true,
        scanned,
        matched: matches.length,
        has_older: hasOlder,
        next_before_offsets: hasOlder ? { '0': cursor } : {},
      },
    })
  }

  it('идёт до конца лога сам и складывает найденное со всех шагов', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(scanPage(5000, [], true, 25000))
      .mockResolvedValueOnce(scanPage(5000, [], true, 20000))
      .mockResolvedValueOnce(scanPage(5000, [10009, 10008], true, 15000))
      .mockResolvedValueOnce(scanPage(3000, [900], false, 0))
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    await useKafkaStore.getState().searchTopic('c1', 'topic', 'tab-all', [{ field: 'Metadata', value: '', op: 'exists' }])
    await useKafkaStore.getState().scanAll('c1', 'topic', 'tab-all')

    const tab = useKafkaStore.getState().tabs['tab-all']
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(tab.scanned).toBe(18000)
    expect(tab.messages.map((m) => m.offset)).toEqual([10009, 10008, 900])
    expect(tab.hasMore).toBe(false)
    expect(tab.deepScanning).toBe(false)
    expect(tab.scanning).toBe(false)
  })

  it('останавливается по Cancel и сохраняет то, что уже нашёл', async () => {
    let calls = 0
    const fetchMock = vi.fn(() => {
      calls += 1
      // На третьем шаге отменяем прямо во время выполнения запроса.
      if (calls === 3) {
        useKafkaStore.getState().cancelScanAll('tab-cancel')
      }
      return Promise.resolve(scanPage(5000, calls === 2 ? [10005] : [], true, 30000 - calls * 5000))
    })
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    await useKafkaStore.getState().searchTopic('c1', 'topic', 'tab-cancel', [{ field: 'Metadata', value: '', op: 'exists' }])
    await useKafkaStore.getState().scanAll('c1', 'topic', 'tab-cancel')

    const tab = useKafkaStore.getState().tabs['tab-cancel']
    expect(tab.deepScanning).toBe(false)
    // Найденное до отмены не теряется.
    expect(tab.messages.map((m) => m.offset)).toEqual([10005])
    // И видно, сколько успели прочитать: топик дочитан не до конца.
    expect(tab.scanned).toBeGreaterThan(0)
    expect(tab.hasMore).toBe(true)
    expect(tab.deepScanCanceled).toBe(true)
  })

  it('не зацикливается, если бэкенд вернул тот же курсор', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(scanPage(10, [], true, 777)))
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    await useKafkaStore.getState().searchTopic('c1', 'topic', 'tab-stuck', [{ field: 'Metadata', value: '', op: 'exists' }])
    await useKafkaStore.getState().scanAll('c1', 'topic', 'tab-stuck')

    // Первый запрос — сам поиск, дальше ровно один шаг цикла, который не сдвинул
    // курсор, после чего цикл обязан остановиться.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3)
    expect(useKafkaStore.getState().tabs['tab-stuck'].deepScanning).toBe(false)
  })
})
