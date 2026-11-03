import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startSqlSessionCleanup } from '@/lib/sqlSessions'
import { useSqlConsoleStore } from '@/stores/sqlConsole'
import { useWorkspaceStore } from '@/stores/workspace'

// The REAL console store against a mocked fetch: every run names its tab as the
// server session, and the transaction state the server reports is what the tab
// shows — including on a failure, and after a Stop that never got a response.
vi.stubGlobal('window', globalThis)

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  useSqlConsoleStore.setState({ tabs: {} })
  useWorkspaceStore.setState({ tabs: [] })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.stubGlobal('window', globalThis)
})

describe('console sessions', () => {
  it.each([
    ['single statement', ['BEGIN'], json({ columns: [], rows: [], rows_affected: 0, duration_ms: 0, rows_returned: 0, transaction: 'open' }), 'open'],
    ['batch', ['BEGIN', 'DROP TABLE t'], json({ results: [], transaction: 'open' }), 'open'],
    ['failed statement', ['SELECT * FROM nope'], json({ error: 'relation does not exist', code: 400, transaction: 'failed' }, 400), 'failed'],
    ['commit', ['COMMIT'], json({ columns: [], rows: [], rows_affected: 0, duration_ms: 0, rows_returned: 0, transaction: 'idle' }), 'idle'],
  ])('%s: sends the tab as session and keeps the reported state', async (_, statements, response, want) => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => response)
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    await useSqlConsoleStore.getState().runStatements('c1', 'c1:sql:1', statements)

    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string)
    expect(body.session_id).toBe('c1:sql:1')
    expect(useSqlConsoleStore.getState().tabs['c1:sql:1'].transaction).toBe(want)
  })

  it('asks the server for the state after a Stop, since the response never came', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/sessions/')) return Promise.resolve(json({ transaction: 'lost' }))
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    })
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    const pending = useSqlConsoleStore.getState().runStatements('c1', 'c1:sql:1', ['SELECT pg_sleep(30)'])
    await Promise.resolve()
    useSqlConsoleStore.getState().cancelRun('c1:sql:1')
    await pending
    await vi.waitFor(() => expect(useSqlConsoleStore.getState().tabs['c1:sql:1'].transaction).toBe('lost'))
    expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/connections/c1/sessions/c1:sql:1')).toBe(true)
  })

  it('drops a state refresh that a newer run overtook', async () => {
    let answerRefresh: (r: Response) => void = () => {}
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input).includes('/sessions/')) return new Promise<Response>((resolve) => (answerRefresh = resolve))
      return Promise.resolve(json({ columns: [], rows: [], rows_affected: 0, duration_ms: 0, rows_returned: 0, transaction: 'open' }))
    })
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    const refresh = useSqlConsoleStore.getState().refreshTransaction('c1', 'c1:sql:1')
    await useSqlConsoleStore.getState().runStatements('c1', 'c1:sql:1', ['BEGIN'])
    answerRefresh(json({ transaction: 'lost' }))
    await refresh
    expect(useSqlConsoleStore.getState().tabs['c1:sql:1'].transaction).toBe('open')
  })
})

describe('session cleanup', () => {
  const sqlTab = (id: string, connId: string) => ({ kind: 'sql', id, connId, label: 'SQL' }) as never

  it('ends the session of a closed console and of one moved to another connection', () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
    const stop = startSqlSessionCleanup()
    useWorkspaceStore.setState({ tabs: [sqlTab('a:sql:1', 'a'), sqlTab('a:sql:2', 'a'), sqlTab('a:sql:3', 'a')] })

    // :1 closes, :2 moves to connection b, :3 stays where it was.
    useWorkspaceStore.setState({ tabs: [sqlTab('a:sql:2', 'b'), sqlTab('a:sql:3', 'a')] })
    stop()

    const ended = fetchMock.mock.calls.map(([url, init]) => `${init?.method} ${url}`)
    expect(ended.sort()).toEqual(['DELETE /api/connections/a/sessions/a:sql:1', 'DELETE /api/connections/a/sessions/a:sql:2'])
  })
})
