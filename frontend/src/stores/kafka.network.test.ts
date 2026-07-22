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
