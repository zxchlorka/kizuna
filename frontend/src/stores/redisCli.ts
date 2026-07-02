import { create } from 'zustand'
import type { ExecResult, ExecuteMultiResponse, HistoryEntry } from '@/types/api'

export interface RedisCliEntry {
  id: string
  statement: string
  result: ExecResult
}

interface RedisCliTabState {
  editorValue: string
  entries: RedisCliEntry[]
  running: boolean
  error: string | null
  history: HistoryEntry[]
  historyCursor: number
  historyDraft: string
  historyLoaded: boolean
}

interface RedisCliStore {
  tabs: Record<string, RedisCliTabState>
  ensureTab: (tabId: string) => void
  setEditorValue: (tabId: string, value: string) => void
  clearOutput: (tabId: string) => void
  fetchHistory: (connId: string, tabId: string) => Promise<void>
  navigateHistory: (connId: string, tabId: string, direction: 'previous' | 'next') => Promise<void>
  runInput: (connId: string, tabId: string, input: string) => Promise<void>
}

function defaultTabState(): RedisCliTabState {
  return {
    editorValue: '',
    entries: [],
    running: false,
    error: null,
    history: [],
    historyCursor: -1,
    historyDraft: '',
    historyLoaded: false,
  }
}

function ensureState(tabs: Record<string, RedisCliTabState>, tabId: string): RedisCliTabState {
  return tabs[tabId] ?? defaultTabState()
}

function createEntryID(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function splitRedisCliStatements(input: string): string[] {
  const statements: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]

    if (quote) {
      current += char
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === quote) {
        quote = null
      }
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }

    if (char === '\n' || char === '\r') {
      if (char === '\r' && input[index + 1] === '\n') {
        continue
      }
      const statement = current.trim()
      if (statement) {
        statements.push(statement)
      }
      current = ''
      continue
    }

    current += char
  }

  const statement = current.trim()
  if (statement) {
    statements.push(statement)
  }

  return statements
}

export const useRedisCliStore = create<RedisCliStore>((set, get) => ({
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

  clearOutput: (tabId) => {
    set((state) => {
      const tab = ensureState(state.tabs, tabId)
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...tab,
            entries: [],
            error: null,
          },
        },
      }
    })
  },

  fetchHistory: async (connId, tabId) => {
    const res = await fetch(`/api/connections/${connId}/history?limit=50`)
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error(body.error || res.statusText)
    }
    const history = (await res.json()) as HistoryEntry[]
    set((state) => {
      const tab = ensureState(state.tabs, tabId)
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...tab,
            history,
            historyLoaded: true,
          },
        },
      }
    })
  },

  navigateHistory: async (connId, tabId, direction) => {
    const current = ensureState(get().tabs, tabId)
    if (!current.historyLoaded) {
      await get().fetchHistory(connId, tabId)
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

  runInput: async (connId, tabId, input) => {
    const trimmed = input.trim()
    if (!trimmed) {
      return
    }

    if (trimmed.toLowerCase() === 'clear') {
      get().clearOutput(tabId)
      set((state) => ({
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...ensureState(state.tabs, tabId),
            editorValue: '',
          },
        },
      }))
      return
    }

    const statements = splitRedisCliStatements(trimmed)

    set((state) => {
      const tab = ensureState(state.tabs, tabId)
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...tab,
            running: true,
            error: null,
            historyCursor: -1,
            historyDraft: '',
          },
        },
      }
    })

    try {
      const isBatch = statements.length > 1
      const endpoint = isBatch ? 'execute-multi' : 'execute'
      const body = isBatch
        ? JSON.stringify({ statements })
        : JSON.stringify({ statement: statements[0] })

      const res = await fetch(`/api/connections/${connId}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
      if (!res.ok) {
        const payload = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(payload.error || res.statusText)
      }

      const rawResults: ExecResult[] = isBatch
        ? (await res.json() as ExecuteMultiResponse).results
        : [await res.json() as ExecResult]

      set((state) => {
        const tab = ensureState(state.tabs, tabId)
        return {
          tabs: {
            ...state.tabs,
            [tabId]: {
              ...tab,
              running: false,
              editorValue: '',
              entries: [
                ...tab.entries,
                ...rawResults.map((result, index) => ({
                  id: createEntryID(`redis-${index}`),
                  statement: statements[index] ?? result.statement ?? '',
                  result,
                })),
              ],
              historyLoaded: false,
            },
          },
        }
      })
    } catch (error) {
      const message = (error as Error).message
      set((state) => {
        const tab = ensureState(state.tabs, tabId)
        return {
          tabs: {
            ...state.tabs,
            [tabId]: {
              ...tab,
              running: false,
              error: message,
              entries: [
                ...tab.entries,
                {
                  id: createEntryID('redis-error'),
                  statement: statements[0] ?? trimmed,
                  result: {
                    columns: [],
                    rows: [],
                    rows_affected: 0,
                    duration_ms: 0,
                    rows_returned: 0,
                    statement: statements[0] ?? trimmed,
                    error: message,
                  },
                },
              ],
            },
          },
        }
      })
    }
  },
}))
