import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useKafkaStore } from '@/stores/kafka'

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

    useKafkaStore.getState().setLoadedFilter('tab-filter', 'src.event_data.events[].name', 'Auth')
    let tab = useKafkaStore.getState().tabs['tab-filter']
    expect(tab.filterActive).toBe(true)
    expect(tab.filterField).toBe('src.event_data.events[].name')

    useKafkaStore.getState().clearLoadedFilter('tab-filter')
    tab = useKafkaStore.getState().tabs['tab-filter']
    expect(tab.filterActive).toBe(false)
    expect(tab.filterField).toBe('')

    // The whole point of "Filter loaded": zero requests, and the cursor state
    // (nextBeforeOffsets/hasOlder) is never mutated by filtering.
    expect(fetchMock).not.toHaveBeenCalled()
    expect(tab.nextBeforeOffsets).toBeNull()
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

    await useKafkaStore.getState().searchTopic('c1', 'topic', 'tab-scan', 'src.event_data.events[].name', 'Auth')

    const tab = useKafkaStore.getState().tabs['tab-scan']
    expect(tab.searchActive).toBe(true)
    expect(tab.messages).toHaveLength(1)
    expect(tab.scanned).toBe(40)
    expect(tab.hasOlder).toBe(true)
    expect(tab.scanning).toBe(false)

    const calledUrl = decodeURIComponent(String(fetchMock.mock.calls[0][0]))
    expect(calledUrl).toContain('match_field')
    expect(calledUrl).toContain('match_value')
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

    await useKafkaStore.getState().searchTopic('c1', 'topic', 'tab-more', 'a.b', 'x')
    await useKafkaStore.getState().scanMore('c1', 'topic', 'tab-more')

    const tab = useKafkaStore.getState().tabs['tab-more']
    expect(tab.messages).toHaveLength(2)
    expect(tab.scanned).toBe(70)
    expect(tab.hasOlder).toBe(false)

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

    await useKafkaStore.getState().searchTopic('c1', 'topic', 'tab-partial', 'a.b', 'x')

    const tab = useKafkaStore.getState().tabs['tab-partial']
    expect(tab.scanPartial).toBe(true)
    expect(tab.messages).toHaveLength(1) // step matches preserved
    expect(tab.hasOlder).toBe(true)
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

    await useKafkaStore.getState().searchTopic('c1', 'topic', 'tab-cancel', 'a.b', 'x')
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
    await useKafkaStore.getState().searchTopic('c1', 'topic', 'tab-remount', 'a.b', 'x')

    const afterSearch = useKafkaStore.getState().tabs['tab-remount']
    expect(afterSearch.searchActive).toBe(true)
    expect(afterSearch.messages).toHaveLength(1)
    expect(afterSearch.scanned).toBe(40)
    expect(afterSearch.nextBeforeOffsets).toEqual({ '0': 5 })

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
    expect(tab.nextBeforeOffsets).toEqual({ '0': 5 })
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

    await useKafkaStore.getState().searchTopic('c1', 'topic', 'tab-refresh-search', 'src.event_data.events[].name', 'Auth')

    const settled = useKafkaStore.getState().tabs['tab-refresh-search']
    expect(settled.searchActive).toBe(true)
    expect(settled.scanning).toBe(false) // settled, not mid-scan
    expect(settled.messages).toHaveLength(1)
    expect(settled.scanned).toBe(40)
    expect(settled.nextBeforeOffsets).toEqual({ '0': 5 })

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
    expect(tab.nextBeforeOffsets).toEqual({ '0': 4 })
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

    await useKafkaStore.getState().searchTopic('c1', 'topic', 'tab-clear', 'a.b', 'x')
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
          hasOlder: true,
          nextBeforeOffsets: { '0': 5 },
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
          hasOlder: true,
          nextBeforeOffsets: { '0': 5 },
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
          searchField: 'src.event_data.events[].name',
          searchValue: 'Auth',
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

  it('drops an offset seek when widening back to all partitions', async () => {
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

    // An offset means nothing without a partition and the backend rejects the
    // pair, so the view must not keep sending it.
    expect(useKafkaStore.getState().tabs['tab-widen'].seekOffset).toBe('')
    expect(filtersOf(fetchMock).some((filter) => filter.column === 'from_offset')).toBe(false)
  })
})
