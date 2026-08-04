import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSqlConsoleStore, type SqlExecutionResult, type SqlResultItem } from '@/stores/sqlConsole'

// SqlResultItem is a kind-discriminated union ('execute' | 'explain'); these
// tests only ever produce 'execute' results (including the synthetic
// canceled/failed ones), so narrow once here instead of repeating the guard.
function asExecute(item: SqlResultItem): SqlExecutionResult {
  if (item.kind !== 'execute') {
    throw new Error(`expected an 'execute' result, got ${item.kind}`)
  }
  return item
}

// These drive the REAL store against a mocked fetch to verify the network-level
// cancel behavior: that Cancel/Stop aborts the actual in-flight HTTP request
// (signal.aborted), that a canceled run does NOT set tab.error / render as a
// failure, and that no internal timeout ever fires for these requests (queries
// can legitimately run 30-40s+; see CLAUDE.md).
//
// fetchWithTimeout uses window.setTimeout/clearTimeout; point window at
// globalThis (real timers) for the node test environment.
vi.stubGlobal('window', globalThis)

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  useSqlConsoleStore.setState({ tabs: {} })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.stubGlobal('window', globalThis)
})

describe('runStatements — cancel', () => {
  it('cancelRun aborts the actual fetch signal and marks the result canceled, not an error', async () => {
    let capturedSignal: AbortSignal | undefined
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    })
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    const pending = useSqlConsoleStore.getState().runStatements('c1', 'tab-1', ['select pg_sleep(30)'])
    await Promise.resolve()
    await Promise.resolve()

    expect(useSqlConsoleStore.getState().tabs['tab-1'].running).toBe(true)
    expect(capturedSignal).toBeDefined()
    expect(capturedSignal!.aborted).toBe(false)

    useSqlConsoleStore.getState().cancelRun('tab-1')

    // The underlying HTTP request was actually aborted, not merely ignored.
    expect(capturedSignal!.aborted).toBe(true)

    await pending

    const tab = useSqlConsoleStore.getState().tabs['tab-1']
    expect(tab.running).toBe(false)
    // Not an error: no tab-level error, and the result reads as canceled.
    expect(tab.error).toBeNull()
    expect(tab.results).toHaveLength(1)
    expect(tab.results[0].kind).toBe('execute')
    const result0 = asExecute(tab.results[0])
    expect(result0.result.canceled).toBe(true)
    expect(result0.result.error).toBeUndefined()
  })

  it('reports a cancelled batch as a batch, not as its first statement', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    })
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    const statements = ["insert into t values ('one')", 'select pg_sleep(30)', "insert into t values ('three')"]
    const pending = useSqlConsoleStore.getState().runStatements('c1', 'tab-batch', statements)
    await Promise.resolve()
    await Promise.resolve()

    useSqlConsoleStore.getState().cancelRun('tab-batch')
    await pending

    const result = asExecute(useSqlConsoleStore.getState().tabs['tab-batch'].results[0])
    expect(result.result.canceled).toBe(true)
    expect(result.label).toBe('Batch')
    // The entry stands for the whole run, so it must not carry (and the UI must
    // not print) the first statement as if that were the one cancelled: by then
    // it had almost certainly committed.
    expect(result.batchScope).toBe(true)
    expect(result.statement).toBe('')
    expect(result.result.statement).toBe('')
  })

  it('still names the single cancelled statement when the run was not a batch', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    })
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    const pending = useSqlConsoleStore.getState().runStatements('c1', 'tab-single', ['select pg_sleep(30)'])
    await Promise.resolve()
    await Promise.resolve()

    useSqlConsoleStore.getState().cancelRun('tab-single')
    await pending

    const result = asExecute(useSqlConsoleStore.getState().tabs['tab-single'].results[0])
    expect(result.label).toBe('Stmt 1')
    expect(result.batchScope).toBeUndefined()
    expect(result.statement).toBe('select pg_sleep(30)')
  })

  it('refreshes an open History panel after a cancel, since it holds the only record of what ran', async () => {
    const historyCalls: string[] = []
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/history')) {
        historyCalls.push(url)
        return Promise.resolve(jsonResponse([]))
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    })
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    useSqlConsoleStore.getState().ensureTab('tab-hist')
    useSqlConsoleStore.getState().setHistoryOpen('tab-hist', true)

    const pending = useSqlConsoleStore.getState().runStatements('c1', 'tab-hist', ['insert into t values (1)', 'select pg_sleep(30)'])
    await Promise.resolve()
    await Promise.resolve()

    useSqlConsoleStore.getState().cancelRun('tab-hist')
    await pending

    expect(historyCalls.length).toBeGreaterThanOrEqual(1)
    // A failed history refresh must not turn a deliberate cancel into a failure.
    expect(useSqlConsoleStore.getState().tabs['tab-hist'].error).toBeNull()
  })

  // The server appends the cancelled batch's history only after it has unwound
  // the query, which happens after the client's abort has already resolved. The
  // first read therefore tends to return the pre-run list; settling for that is
  // what left the panel showing stale entries with nothing scheduled to correct it.
  it('keeps reading History until the cancelled run actually lands', async () => {
    const entry = (id: string) => ({
      id,
      command: 'insert into t values (1)',
      duration_ms: 1,
      rows_returned: 0,
      rows_affected: 1,
      executed_at: '2026-08-04T10:00:00Z',
    })
    let historyCalls = 0
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/history')) {
        historyCalls += 1
        // The server has not written the cancelled batch yet on the first read.
        return Promise.resolve(jsonResponse(historyCalls < 3 ? [entry('old')] : [entry('new'), entry('old')]))
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    })
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    useSqlConsoleStore.getState().ensureTab('tab-race')
    useSqlConsoleStore.getState().setHistoryOpen('tab-race', true)
    useSqlConsoleStore.setState((state) => ({
      tabs: { ...state.tabs, 'tab-race': { ...state.tabs['tab-race'], history: [entry('old')] } },
    }))

    const pending = useSqlConsoleStore.getState().runStatements('c1', 'tab-race', ['insert into t values (1)', 'select pg_sleep(30)'])
    await Promise.resolve()
    await Promise.resolve()

    useSqlConsoleStore.getState().cancelRun('tab-race')
    await pending

    const tab = useSqlConsoleStore.getState().tabs['tab-race']
    expect(tab.history[0]?.id).toBe('new')
    expect(historyCalls).toBe(3)
  })

  it('gives up rereading History when a cancelled run wrote nothing at all', async () => {
    let historyCalls = 0
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/history')) {
        historyCalls += 1
        return Promise.resolve(jsonResponse([]))
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    })
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    useSqlConsoleStore.getState().ensureTab('tab-nohist')
    useSqlConsoleStore.getState().setHistoryOpen('tab-nohist', true)

    const pending = useSqlConsoleStore.getState().runStatements('c1', 'tab-nohist', ['select pg_sleep(30)'])
    await Promise.resolve()
    await Promise.resolve()

    useSqlConsoleStore.getState().cancelRun('tab-nohist')
    await pending

    // Bounded: it stops on its own rather than spinning on a run that will
    // never appear.
    expect(historyCalls).toBe(5)
    expect(useSqlConsoleStore.getState().tabs['tab-nohist'].running).toBe(false)
  })

  it('cancelRun on one tab does not touch another tab running concurrently', async () => {
    const pendingSignals = new Map<string, AbortSignal>()
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const tab = url.includes('conn-a') ? 'tab-a' : 'tab-b'
      if (init?.signal) pendingSignals.set(tab, init.signal)
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    })
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    const pendingA = useSqlConsoleStore.getState().runStatements('conn-a', 'tab-a', ['select pg_sleep(30)'])
    const pendingB = useSqlConsoleStore.getState().runStatements('conn-b', 'tab-b', ['select pg_sleep(30)'])
    await Promise.resolve()
    await Promise.resolve()

    useSqlConsoleStore.getState().cancelRun('tab-a')

    expect(pendingSignals.get('tab-a')!.aborted).toBe(true)
    expect(pendingSignals.get('tab-b')!.aborted).toBe(false)
    expect(useSqlConsoleStore.getState().tabs['tab-b'].running).toBe(true)

    await pendingA
    // tab-b is still hanging; abort it directly so the test doesn't leak a
    // dangling promise.
    useSqlConsoleStore.getState().cancelRun('tab-b')
    await pendingB
  })

  it('a normal (non-aborted) failure still renders as an error, not canceled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: 'syntax error' }), { status: 400 })
        )
      ) as unknown as typeof fetch
    )

    await useSqlConsoleStore.getState().runStatements('c1', 'tab-err', ['not sql'])

    const tab = useSqlConsoleStore.getState().tabs['tab-err']
    expect(tab.running).toBe(false)
    expect(tab.error).toBe('syntax error')
    const errResult = asExecute(tab.results[0])
    expect(errResult.result.error).toBe('syntax error')
    expect(errResult.result.canceled).toBeUndefined()
  })

  it('never arms an internal timeout for the execute request', async () => {
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout')
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({ columns: [], rows: [], rows_affected: 0, duration_ms: 1, rows_returned: 0 })
        )
      ) as unknown as typeof fetch
    )

    await useSqlConsoleStore.getState().runStatements('c1', 'tab-notimeout', ['select 1'])

    expect(setTimeoutSpy).not.toHaveBeenCalled()
    setTimeoutSpy.mockRestore()
  })
})

describe('runExplain / runAnalyze — cancel', () => {
  it('runExplain: cancelRun marks the result canceled', async () => {
    let capturedSignal: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        capturedSignal = init?.signal ?? undefined
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        })
      }) as unknown as typeof fetch
    )

    const pending = useSqlConsoleStore.getState().runExplain('c1', 'tab-explain', 'select 1')
    await Promise.resolve()
    await Promise.resolve()

    useSqlConsoleStore.getState().cancelRun('tab-explain')
    expect(capturedSignal!.aborted).toBe(true)

    await pending
    const tab = useSqlConsoleStore.getState().tabs['tab-explain']
    expect(tab.running).toBe(false)
    expect(tab.error).toBeNull()
    expect(asExecute(tab.results[0]).result.canceled).toBe(true)
  })

  it('runAnalyze: cancelRun marks the result canceled', async () => {
    let capturedSignal: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        capturedSignal = init?.signal ?? undefined
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        })
      }) as unknown as typeof fetch
    )

    const pending = useSqlConsoleStore.getState().runAnalyze('c1', 'tab-analyze', 'select 1')
    await Promise.resolve()
    await Promise.resolve()

    useSqlConsoleStore.getState().cancelRun('tab-analyze')
    expect(capturedSignal!.aborted).toBe(true)

    await pending
    const tab = useSqlConsoleStore.getState().tabs['tab-analyze']
    expect(tab.running).toBe(false)
    expect(tab.error).toBeNull()
    expect(asExecute(tab.results[0]).result.canceled).toBe(true)
  })
})

describe('runStatements — Stop followed immediately by Run', () => {
  // cancelRun flips `running` off right away so the toolbar reacts without
  // waiting on the network. That lets a second Run start before the aborted
  // request's own catch handler fires. That stale handler used to overwrite the
  // new run's state: Stop disappeared and the result read "canceled" while the
  // second query was still executing.
  it('the aborted run does not overwrite the state of the run that replaced it', async () => {
    const signals: AbortSignal[] = []
    let resolveSecond: ((res: Response) => void) | undefined

    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal
      if (signal) signals.push(signal)
      if (signals.length === 1) {
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        })
      }
      return new Promise<Response>((resolve) => {
        resolveSecond = resolve
      })
    })
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    const first = useSqlConsoleStore.getState().runStatements('c1', 'tab-1', ['select pg_sleep(30)'])
    await Promise.resolve()
    await Promise.resolve()

    useSqlConsoleStore.getState().cancelRun('tab-1')

    // Second Run starts before the first one's rejection has been handled.
    const second = useSqlConsoleStore.getState().runStatements('c1', 'tab-1', ['select 2'])
    await Promise.resolve()
    await Promise.resolve()
    await first

    // The second query is still in flight, so the tab must still read as running
    // and must NOT be showing the first run's canceled result.
    const midway = useSqlConsoleStore.getState().tabs['tab-1']
    expect(midway.running).toBe(true)
    expect(midway.results.some((item) => item.kind === 'execute' && asExecute(item).result.canceled)).toBe(false)

    resolveSecond!(
      new Response(JSON.stringify({ columns: ['?column?'], rows: [[2]], rows_affected: 0, duration_ms: 1, rows_returned: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
    await second

    const tab = useSqlConsoleStore.getState().tabs['tab-1']
    expect(tab.running).toBe(false)
    expect(tab.error).toBeNull()
    expect(asExecute(tab.results[0]).result.canceled).toBeUndefined()
    expect(asExecute(tab.results[0]).result.rows).toEqual([[2]])
  })
})
