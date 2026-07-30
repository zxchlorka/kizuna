import { create } from 'zustand'
import type {
  ExecResult,
  ExecuteMultiResponse,
  ExplainResult,
  HistoryEntry,
} from '@/types/api'
import { apiFetch, fetchWithTimeout, RequestAbortedError } from '@/lib/http'

export interface SqlExecutionResult {
  id: string
  kind: 'execute'
  label: string
  statementIndex: number
  statement: string
  result: ExecResult
}

export interface SqlExplainExecutionResult {
  id: string
  kind: 'explain'
  label: string
  statementIndex: number
  statement: string
  result: ExplainResult
}

export type SqlResultItem = SqlExecutionResult | SqlExplainExecutionResult

interface SqlTabState {
  editorValue: string
  results: SqlResultItem[]
  activeResultId: string | null
  running: boolean
  error: string | null
  splitSize: number
  resultsCollapsed: boolean
  historyOpen: boolean
  history: HistoryEntry[]
  historyLoading: boolean
  historySearch: string
  historyCursor: number
  historyDraft: string
}

interface SqlConsoleStore {
  tabs: Record<string, SqlTabState>
  ensureTab: (tabId: string) => void
  setEditorValue: (tabId: string, value: string) => void
  setSplitSize: (tabId: string, splitSize: number) => void
  setResultsCollapsed: (tabId: string, collapsed: boolean) => void
  toggleHistory: (tabId: string) => void
  setHistoryOpen: (tabId: string, open: boolean) => void
  setHistorySearch: (tabId: string, search: string) => void
  setActiveResult: (tabId: string, resultId: string) => void
  applyHistoryCommand: (tabId: string, command: string) => void
  navigateHistory: (connId: string, tabId: string, direction: 'previous' | 'next') => Promise<void>
  fetchHistory: (connId: string, tabId: string, search?: string) => Promise<void>
  clearHistory: (connId: string, tabId: string) => Promise<void>
  runStatements: (connId: string, tabId: string, statements: string[]) => Promise<void>
  runExplain: (connId: string, tabId: string, statement: string) => Promise<void>
  runAnalyze: (connId: string, tabId: string, statement: string) => Promise<void>
  cancelRun: (tabId: string) => void
}

const defaultTabState = (): SqlTabState => ({
  editorValue: '',
  results: [],
  activeResultId: null,
  running: false,
  error: null,
  splitSize: 42,
  resultsCollapsed: false,
  historyOpen: false,
  history: [],
  historyLoading: false,
  historySearch: '',
  historyCursor: -1,
  historyDraft: '',
})

function ensureState(tabs: Record<string, SqlTabState>, tabId: string): SqlTabState {
  return tabs[tabId] ?? defaultTabState()
}

function newResultId(prefix: string, statementIndex: number): string {
  return `${prefix}-${statementIndex}-${Date.now()}`
}

function normalizeHistory(items: HistoryEntry[]): HistoryEntry[] {
  return items ?? []
}

function explainLabel(result: ExplainResult, fallback: 'EXPLAIN' | 'ANALYZE'): string {
  return result.mode === 'analyze' ? 'ANALYZE' : fallback
}

// One run (execute/execute-multi/explain/analyze) at a time per tab -- the
// toolbar disables Run/Explain/Analyze while `running` is true -- so a single
// controller per tabId is enough. Kept outside Zustand state, mirroring
// kafkaScanControllers in stores/kafka.ts: AbortController is a mutable,
// non-serializable handle, not view state Cancel can act on it directly.
const sqlRunControllers = new Map<string, AbortController>()

// A run owns its tab's state only while its AbortController is the one stored
// for that tab. Stop flips `running` off immediately so the toolbar reacts
// without waiting on the network, which lets the user start a new run before the
// aborted request's own catch handler fires. Without this check that stale
// handler overwrites the new run's state — clearing its Stop button and showing
// "canceled" while the second query is still executing.
function isCurrentRun(tabId: string, controller: AbortController): boolean {
  return sqlRunControllers.get(tabId) === controller
}

// Console requests carry no timeout — a legitimate query can run 30-40s+, so
// every run below passes Infinity as fetchWithTimeout's timeoutMs and the
// AbortController above is the only thing that can end the request.
//
// `startedAt` is a Date.now() taken just before the request went out. A canceled
// run never gets a server-reported duration, and showing 0ms for a query the user
// watched run for seconds reads as a bug in a tool meant for diagnosing slow
// queries. This is wall-clock including request overhead, not server execution
// time — approximate, but the only number available.
function canceledResult(statement: string, label: string, startedAt: number): SqlResultItem {
  return {
    id: newResultId('stmt', 0),
    kind: 'execute',
    label,
    statementIndex: 0,
    statement,
    result: {
      columns: [],
      rows: [],
      rows_affected: 0,
      duration_ms: Math.max(0, Date.now() - startedAt),
      rows_returned: 0,
      canceled: true,
      statement,
    },
  }
}

export const useSqlConsoleStore = create<SqlConsoleStore>((set, get) => ({
  tabs: {},

  ensureTab: (tabId) => {
    set((state) => ({
      tabs: {
        ...state.tabs,
        [tabId]: ensureState(state.tabs, tabId),
      },
    }))
  },

  setEditorValue: (tabId, value) => {
    set((state) => {
      const tab = ensureState(state.tabs, tabId)
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...tab,
            editorValue: value,
            historyCursor: -1,
            historyDraft: value,
          },
        },
      }
    })
  },

  setSplitSize: (tabId, splitSize) => {
    set((state) => {
      const tab = ensureState(state.tabs, tabId)
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...tab,
            splitSize: Math.max(25, Math.min(75, splitSize)),
          },
        },
      }
    })
  },

  setResultsCollapsed: (tabId, collapsed) => {
    set((state) => {
      const tab = ensureState(state.tabs, tabId)
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...tab,
            resultsCollapsed: collapsed,
          },
        },
      }
    })
  },

  toggleHistory: (tabId) => {
    set((state) => {
      const tab = ensureState(state.tabs, tabId)
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...tab,
            historyOpen: !tab.historyOpen,
          },
        },
      }
    })
  },

  setHistoryOpen: (tabId, open) => {
    set((state) => {
      const tab = ensureState(state.tabs, tabId)
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...tab,
            historyOpen: open,
          },
        },
      }
    })
  },

  setHistorySearch: (tabId, search) => {
    set((state) => {
      const tab = ensureState(state.tabs, tabId)
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...tab,
            historySearch: search,
          },
        },
      }
    })
  },

  setActiveResult: (tabId, resultId) => {
    set((state) => {
      const tab = ensureState(state.tabs, tabId)
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...tab,
            activeResultId: resultId,
          },
        },
      }
    })
  },

  applyHistoryCommand: (tabId, command) => {
    set((state) => {
      const tab = ensureState(state.tabs, tabId)
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...tab,
            editorValue: command,
            historyCursor: -1,
            historyDraft: command,
          },
        },
      }
    })
  },

  navigateHistory: async (connId, tabId, direction) => {
    const current = ensureState(get().tabs, tabId)
    if (current.history.length === 0) {
      await get().fetchHistory(connId, tabId, current.historySearch)
    }

    const tab = ensureState(get().tabs, tabId)
    if (tab.history.length === 0) {
      return
    }

    let nextCursor = tab.historyCursor
    if (direction === 'previous') {
      nextCursor = Math.min(tab.history.length - 1, tab.historyCursor + 1)
    } else {
      nextCursor = tab.historyCursor - 1
    }

    set((state) => {
      const latest = ensureState(state.tabs, tabId)
      if (direction === 'next' && nextCursor < 0) {
        return {
          tabs: {
            ...state.tabs,
            [tabId]: {
              ...latest,
              historyCursor: -1,
              editorValue: latest.historyDraft,
            },
          },
        }
      }

      const draft = latest.historyCursor === -1 ? latest.editorValue : latest.historyDraft
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...latest,
            historyCursor: nextCursor,
            historyDraft: draft,
            editorValue: latest.history[nextCursor]?.command ?? latest.editorValue,
          },
        },
      }
    })
  },

  fetchHistory: async (connId, tabId, search) => {
    set((state) => {
      const tab = ensureState(state.tabs, tabId)
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...tab,
            historyLoading: true,
          },
        },
      }
    })

    const activeSearch = search ?? ensureState(get().tabs, tabId).historySearch
    const params = new URLSearchParams({ limit: '50' })
    if (activeSearch.trim()) {
      params.set('search', activeSearch.trim())
    }

    try {
      const res = await apiFetch(`/api/connections/${connId}/history?${params.toString()}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(body.error || res.statusText)
      }

      const history = normalizeHistory(await res.json())
      set((state) => {
        const tab = ensureState(state.tabs, tabId)
        return {
          tabs: {
            ...state.tabs,
            [tabId]: {
              ...tab,
              history,
              historyLoading: false,
              error: null,
            },
          },
        }
      })
    } catch (error) {
      set((state) => {
        const tab = ensureState(state.tabs, tabId)
        return {
          tabs: {
            ...state.tabs,
            [tabId]: {
              ...tab,
              historyLoading: false,
              error: (error as Error).message,
            },
          },
        }
      })
    }
  },

  clearHistory: async (connId, tabId) => {
    const res = await apiFetch(`/api/connections/${connId}/history`, { method: 'DELETE' })
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error(body.error || res.statusText)
    }

    set((state) => {
      const tab = ensureState(state.tabs, tabId)
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...tab,
            history: [],
            historyCursor: -1,
          },
        },
      }
    })
  },

  runStatements: async (connId, tabId, statements) => {
    const trimmedStatements = statements.map((statement) => statement.trim()).filter(Boolean)
    if (trimmedStatements.length === 0) {
      return
    }

    set((state) => {
      const tab = ensureState(state.tabs, tabId)
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...tab,
            running: true,
            error: null,
            results: [],
            activeResultId: null,
            resultsCollapsed: false,
          },
        },
      }
    })

    sqlRunControllers.get(tabId)?.abort()
    const controller = new AbortController()
    sqlRunControllers.set(tabId, controller)
    const startedAt = Date.now()

    try {
      const endpoint = trimmedStatements.length === 1 ? 'execute' : 'execute-multi'
      const body =
        trimmedStatements.length === 1
          ? JSON.stringify({ statement: trimmedStatements[0] })
          : JSON.stringify({ statements: trimmedStatements })

      const res = await fetchWithTimeout(
        `/api/connections/${connId}/${endpoint}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        },
        Infinity,
        controller.signal
      )

      if (!res.ok) {
        const payload = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(payload.error || res.statusText)
      }

      const rawResults: ExecResult[] =
        trimmedStatements.length === 1
          ? [await res.json()]
          : (await res.json() as ExecuteMultiResponse).results

      const results: SqlResultItem[] = rawResults.map((result, index) => ({
        id: newResultId('stmt', index),
        kind: 'execute',
        label: `Stmt ${index + 1}`,
        statementIndex: index,
        statement: trimmedStatements[index] ?? result.statement ?? '',
        result,
      }))

      // A run owns the tab only while its controller is the current one — see
      // isCurrentRun. Bail out otherwise so a run that was stopped cannot
      // overwrite the state of the run that replaced it.
      if (!isCurrentRun(tabId, controller)) {
        return
      }

      set((state) => {
        const tab = ensureState(state.tabs, tabId)
        return {
          tabs: {
            ...state.tabs,
            [tabId]: {
              ...tab,
              running: false,
              error: null,
              results,
              activeResultId: results[0]?.id ?? null,
            },
          },
        }
      })

      if (ensureState(get().tabs, tabId).historyOpen) {
        await get().fetchHistory(connId, tabId)
      }
    } catch (error) {
      // A run owns the tab only while its controller is the current one — see
      // isCurrentRun. Bail out otherwise so a run that was stopped cannot
      // overwrite the state of the run that replaced it.
      if (!isCurrentRun(tabId, controller)) {
        return
      }

      if (error instanceof RequestAbortedError) {
        // Deliberate Cancel/Stop, not a failure: leave `error` unset so the
        // console doesn't render a "failed" state, and mark the synthetic
        // result canceled instead of erroring it.
        const result = canceledResult(trimmedStatements[0], trimmedStatements.length > 1 ? 'Batch' : 'Stmt 1', startedAt)
        set((state) => {
          const tab = ensureState(state.tabs, tabId)
          return {
            tabs: {
              ...state.tabs,
              [tabId]: {
                ...tab,
                running: false,
                error: null,
                results: [result],
                activeResultId: result.id,
              },
            },
          }
        })
        return
      }

      const message = (error as Error).message
      const failedResult: SqlResultItem = {
        id: newResultId('stmt', 0),
        kind: 'execute',
        label: 'Stmt 1',
        statementIndex: 0,
        statement: trimmedStatements[0],
        result: {
          columns: [],
          rows: [],
          rows_affected: 0,
          duration_ms: 0,
          rows_returned: 0,
          error: message,
          statement: trimmedStatements[0],
        },
      }

      set((state) => {
        const tab = ensureState(state.tabs, tabId)
        return {
          tabs: {
            ...state.tabs,
            [tabId]: {
              ...tab,
              running: false,
              error: message,
              results: [failedResult],
              activeResultId: failedResult.id,
            },
          },
        }
      })
    } finally {
      if (sqlRunControllers.get(tabId) === controller) {
        sqlRunControllers.delete(tabId)
      }
    }
  },

  runExplain: async (connId, tabId, statement) => {
    const trimmed = statement.trim()
    if (!trimmed) {
      return
    }

    set((state) => {
      const tab = ensureState(state.tabs, tabId)
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...tab,
            running: true,
            error: null,
            results: [],
            activeResultId: null,
            resultsCollapsed: false,
          },
        },
      }
    })

    sqlRunControllers.get(tabId)?.abort()
    const controller = new AbortController()
    sqlRunControllers.set(tabId, controller)
    const startedAt = Date.now()

    try {
      const res = await fetchWithTimeout(
        `/api/connections/${connId}/explain`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: trimmed }),
        },
        Infinity,
        controller.signal
      )
      if (!res.ok) {
        const payload = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(payload.error || res.statusText)
      }

      const result: ExplainResult = await res.json()
      const explainResult: SqlResultItem = {
        id: newResultId('explain', 0),
        kind: 'explain',
        label: explainLabel(result, 'EXPLAIN'),
        statementIndex: 0,
        statement: trimmed,
        result,
      }

      // A run owns the tab only while its controller is the current one — see
      // isCurrentRun. Bail out otherwise so a run that was stopped cannot
      // overwrite the state of the run that replaced it.
      if (!isCurrentRun(tabId, controller)) {
        return
      }

      set((state) => {
        const tab = ensureState(state.tabs, tabId)
        return {
          tabs: {
            ...state.tabs,
            [tabId]: {
              ...tab,
              running: false,
              results: [explainResult],
              activeResultId: explainResult.id,
            },
          },
        }
      })
    } catch (error) {
      // A run owns the tab only while its controller is the current one — see
      // isCurrentRun. Bail out otherwise so a run that was stopped cannot
      // overwrite the state of the run that replaced it.
      if (!isCurrentRun(tabId, controller)) {
        return
      }

      if (error instanceof RequestAbortedError) {
        const result = canceledResult(trimmed, 'EXPLAIN', startedAt)
        set((state) => {
          const tab = ensureState(state.tabs, tabId)
          return {
            tabs: {
              ...state.tabs,
              [tabId]: {
                ...tab,
                running: false,
                error: null,
                results: [result],
                activeResultId: result.id,
              },
            },
          }
        })
        return
      }

      const message = (error as Error).message
      const failedResult: SqlResultItem = {
        id: newResultId('stmt', 0),
        kind: 'execute',
        label: 'EXPLAIN',
        statementIndex: 0,
        statement: trimmed,
        result: {
          columns: [],
          rows: [],
          rows_affected: 0,
          duration_ms: 0,
          rows_returned: 0,
          error: message,
          statement: trimmed,
        },
      }

      set((state) => {
        const tab = ensureState(state.tabs, tabId)
        return {
          tabs: {
            ...state.tabs,
            [tabId]: {
              ...tab,
              running: false,
              error: message,
              results: [failedResult],
              activeResultId: failedResult.id,
            },
          },
        }
      })
    } finally {
      if (sqlRunControllers.get(tabId) === controller) {
        sqlRunControllers.delete(tabId)
      }
    }
  },

  runAnalyze: async (connId, tabId, statement) => {
    const trimmed = statement.trim()
    if (!trimmed) {
      return
    }

    set((state) => {
      const tab = ensureState(state.tabs, tabId)
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...tab,
            running: true,
            error: null,
            results: [],
            activeResultId: null,
            resultsCollapsed: false,
          },
        },
      }
    })

    sqlRunControllers.get(tabId)?.abort()
    const controller = new AbortController()
    sqlRunControllers.set(tabId, controller)
    const startedAt = Date.now()

    try {
      const res = await fetchWithTimeout(
        `/api/connections/${connId}/analyze`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: trimmed }),
        },
        Infinity,
        controller.signal
      )
      if (!res.ok) {
        const payload = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(payload.error || res.statusText)
      }

      const result: ExplainResult = await res.json()
      const analyzeResult: SqlResultItem = {
        id: newResultId('analyze', 0),
        kind: 'explain',
        label: explainLabel(result, 'ANALYZE'),
        statementIndex: 0,
        statement: trimmed,
        result,
      }

      // A run owns the tab only while its controller is the current one — see
      // isCurrentRun. Bail out otherwise so a run that was stopped cannot
      // overwrite the state of the run that replaced it.
      if (!isCurrentRun(tabId, controller)) {
        return
      }

      set((state) => {
        const tab = ensureState(state.tabs, tabId)
        return {
          tabs: {
            ...state.tabs,
            [tabId]: {
              ...tab,
              running: false,
              results: [analyzeResult],
              activeResultId: analyzeResult.id,
            },
          },
        }
      })
    } catch (error) {
      // A run owns the tab only while its controller is the current one — see
      // isCurrentRun. Bail out otherwise so a run that was stopped cannot
      // overwrite the state of the run that replaced it.
      if (!isCurrentRun(tabId, controller)) {
        return
      }

      if (error instanceof RequestAbortedError) {
        const result = canceledResult(trimmed, 'ANALYZE', startedAt)
        set((state) => {
          const tab = ensureState(state.tabs, tabId)
          return {
            tabs: {
              ...state.tabs,
              [tabId]: {
                ...tab,
                running: false,
                error: null,
                results: [result],
                activeResultId: result.id,
              },
            },
          }
        })
        return
      }

      const message = (error as Error).message
      const failedResult: SqlResultItem = {
        id: newResultId('stmt', 0),
        kind: 'execute',
        label: 'ANALYZE',
        statementIndex: 0,
        statement: trimmed,
        result: {
          columns: [],
          rows: [],
          rows_affected: 0,
          duration_ms: 0,
          rows_returned: 0,
          error: message,
          statement: trimmed,
        },
      }

      set((state) => {
        const tab = ensureState(state.tabs, tabId)
        return {
          tabs: {
            ...state.tabs,
            [tabId]: {
              ...tab,
              running: false,
              error: message,
              results: [failedResult],
              activeResultId: failedResult.id,
            },
          },
        }
      })
    } finally {
      if (sqlRunControllers.get(tabId) === controller) {
        sqlRunControllers.delete(tabId)
      }
    }
  },

  cancelRun: (tabId) => {
    // Abort the in-flight HTTP request directly (not just flip a flag): the
    // aborted request's own catch handler flips `running` off and marks the
    // result canceled. Setting `running: false` here too makes the toolbar
    // react immediately instead of waiting on the network round-trip.
    sqlRunControllers.get(tabId)?.abort()
    set((state) => ({
      tabs: { ...state.tabs, [tabId]: { ...ensureState(state.tabs, tabId), running: false } },
    }))
  },
}))
