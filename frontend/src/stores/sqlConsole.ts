import { create } from 'zustand'
import type {
  ExecResult,
  ExecuteMultiResponse,
  ExplainResult,
  HistoryEntry,
} from '@/types/api'

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
      const res = await fetch(`/api/connections/${connId}/history?${params.toString()}`)
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
    const res = await fetch(`/api/connections/${connId}/history`, { method: 'DELETE' })
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

    try {
      const endpoint = trimmedStatements.length === 1 ? 'execute' : 'execute-multi'
      const body =
        trimmedStatements.length === 1
          ? JSON.stringify({ statement: trimmedStatements[0] })
          : JSON.stringify({ statements: trimmedStatements })

      const res = await fetch(`/api/connections/${connId}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })

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

    try {
      const res = await fetch(`/api/connections/${connId}/explain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: trimmed }),
      })
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

    try {
      const res = await fetch(`/api/connections/${connId}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: trimmed }),
      })
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
    }
  },
}))
