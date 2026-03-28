import { create } from 'zustand'
import type {
  BulkMutateOp,
  BulkMutateResult,
  ColumnMeta,
  DataOpts,
  DataResult,
  MutateOp,
} from '@/types/api'

interface TabData {
  columns: ColumnMeta[]
  rows: any[][]
  total: number
  loading: boolean
  error: string | null
  opts: DataOpts
  draftUpdates: Record<number, Record<string, any>>
  draftDeletes: number[]
  draftInserts: Record<string, any>[]
}

interface DataStore {
  tabs: Record<string, TabData>
  fetchSchema: (connId: string, object: string, tabId: string) => Promise<void>
  fetchData: (connId: string, object: string, tabId: string, opts?: Partial<DataOpts>) => Promise<void>
  mutate: (connId: string, op: MutateOp, tabId: string) => Promise<void>
  mutateBulk: (connId: string, op: BulkMutateOp, tabId: string) => Promise<BulkMutateResult>
  setOpts: (tabId: string, opts: Partial<DataOpts>) => void
  setDraftCell: (tabId: string, rowIndex: number, column: string, value: any) => void
  toggleDraftDelete: (tabId: string, rowIndex: number, deleted: boolean) => void
  stageInsert: (tabId: string, data: Record<string, any>) => void
  removeStagedInsert: (tabId: string, index: number) => void
  clearDrafts: (tabId: string) => void
}

const DEFAULT_OPTS: DataOpts = {
  offset: 0,
  limit: 50,
  order_by: '',
  order_dir: 'asc',
  filters: [],
}

function getOrInitTab(tabs: Record<string, TabData>, tabId: string): TabData {
  return (
    tabs[tabId] ?? {
      columns: [],
      rows: [],
      total: 0,
      loading: false,
      error: null,
      opts: { ...DEFAULT_OPTS },
      draftUpdates: {},
      draftDeletes: [],
      draftInserts: [],
    }
  )
}

function cloneDraftUpdates(updates: Record<number, Record<string, any>>): Record<number, Record<string, any>> {
  const next: Record<number, Record<string, any>> = {}
  Object.entries(updates).forEach(([rowIdx, rowChanges]) => {
    next[Number(rowIdx)] = { ...rowChanges }
  })
  return next
}

export const useDataStore = create<DataStore>((set, get) => ({
  tabs: {},

  fetchSchema: async (connId: string, object: string, tabId: string) => {
    try {
      const res = await fetch(`/api/connections/${connId}/objects/${encodeURIComponent(object)}/schema`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(body.error || res.statusText)
      }
      const data: { columns: ColumnMeta[] } = await res.json()
      set((state) => {
        const tab = getOrInitTab(state.tabs, tabId)
        return {
          tabs: {
            ...state.tabs,
            [tabId]: { ...tab, columns: data.columns, error: null },
          },
        }
      })
    } catch (e) {
      set((state) => {
        const tab = getOrInitTab(state.tabs, tabId)
        return {
          tabs: {
            ...state.tabs,
            [tabId]: { ...tab, error: (e as Error).message },
          },
        }
      })
    }
  },

  fetchData: async (connId: string, object: string, tabId: string, partialOpts?: Partial<DataOpts>) => {
    set((state) => {
      const tab = getOrInitTab(state.tabs, tabId)
      const mergedOpts = { ...tab.opts, ...(partialOpts ?? {}) }
      return {
        tabs: {
          ...state.tabs,
          [tabId]: { ...tab, loading: true, error: null, opts: mergedOpts },
        },
      }
    })

    const { tabs } = get()
    const tab = tabs[tabId] ?? { opts: { ...DEFAULT_OPTS } }
    const opts = tab.opts

    const params = new URLSearchParams({
      offset: String(opts.offset),
      limit: String(opts.limit),
    })
    if (opts.order_by) {
      params.set('order_by', opts.order_by)
      params.set('order_dir', opts.order_dir)
    }
    if (opts.filters && opts.filters.length > 0) {
      params.set('filters', JSON.stringify(opts.filters))
    }

    try {
      const res = await fetch(
        `/api/connections/${connId}/objects/${encodeURIComponent(object)}/data?${params.toString()}`
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(body.error || res.statusText)
      }
      const result: DataResult = await res.json()
      set((state) => {
        const current = getOrInitTab(state.tabs, tabId)
        return {
          tabs: {
            ...state.tabs,
            [tabId]: {
              ...current,
              columns: result.columns ?? current.columns,
              rows: result.rows ?? [],
              total: result.total ?? 0,
              loading: false,
              error: null,
            },
          },
        }
      })
    } catch (e) {
      set((state) => {
        const current = getOrInitTab(state.tabs, tabId)
        return {
          tabs: {
            ...state.tabs,
            [tabId]: { ...current, loading: false, error: (e as Error).message },
          },
        }
      })
    }
  },

  mutate: async (connId: string, op: MutateOp, tabId: string) => {
    try {
      const res = await fetch(`/api/connections/${connId}/mutate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(op),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(body.error || res.statusText)
      }

      const { tabs: currentTabs } = get()
      const currentTab = currentTabs[tabId]
      if (currentTab) {
        const fullObject = op.schema ? `${op.schema}.${op.object}` : op.object
        await get().fetchData(connId, fullObject, tabId, currentTab.opts)
      }
    } catch (e) {
      set((state) => {
        const current = getOrInitTab(state.tabs, tabId)
        return {
          tabs: {
            ...state.tabs,
            [tabId]: { ...current, error: (e as Error).message },
          },
        }
      })
      throw e
    }
  },

  mutateBulk: async (connId: string, op: BulkMutateOp, tabId: string) => {
    try {
      const res = await fetch(`/api/connections/${connId}/mutate/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(op),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(body.error || res.statusText)
      }

      const result: BulkMutateResult = await res.json()

      const { tabs: currentTabs } = get()
      const currentTab = currentTabs[tabId]
      if (currentTab) {
        await get().fetchData(connId, `${op.schema}.${op.object}`, tabId, currentTab.opts)
      }

      return result
    } catch (e) {
      set((state) => {
        const current = getOrInitTab(state.tabs, tabId)
        return {
          tabs: {
            ...state.tabs,
            [tabId]: { ...current, error: (e as Error).message },
          },
        }
      })
      throw e
    }
  },

  setOpts: (tabId: string, partialOpts: Partial<DataOpts>) => {
    set((state) => {
      const tab = getOrInitTab(state.tabs, tabId)
      const isFilterOrSortChange =
        'filters' in partialOpts || 'order_by' in partialOpts || 'order_dir' in partialOpts
      const newOpts: DataOpts = {
        ...tab.opts,
        ...partialOpts,
        offset: isFilterOrSortChange ? 0 : (partialOpts.offset ?? tab.opts.offset),
      }
      return {
        tabs: {
          ...state.tabs,
          [tabId]: { ...tab, opts: newOpts },
        },
      }
    })
  },

  setDraftCell: (tabId: string, rowIndex: number, column: string, value: any) => {
    set((state) => {
      const tab = getOrInitTab(state.tabs, tabId)
      const nextUpdates = cloneDraftUpdates(tab.draftUpdates)
      const rowDraft = { ...(nextUpdates[rowIndex] ?? {}) }
      rowDraft[column] = value
      nextUpdates[rowIndex] = rowDraft
      return {
        tabs: {
          ...state.tabs,
          [tabId]: { ...tab, draftUpdates: nextUpdates },
        },
      }
    })
  },

  toggleDraftDelete: (tabId: string, rowIndex: number, deleted: boolean) => {
    set((state) => {
      const tab = getOrInitTab(state.tabs, tabId)
      const current = new Set(tab.draftDeletes)
      if (deleted) {
        current.add(rowIndex)
      } else {
        current.delete(rowIndex)
      }
      return {
        tabs: {
          ...state.tabs,
          [tabId]: { ...tab, draftDeletes: Array.from(current) },
        },
      }
    })
  },

  stageInsert: (tabId: string, data: Record<string, any>) => {
    set((state) => {
      const tab = getOrInitTab(state.tabs, tabId)
      return {
        tabs: {
          ...state.tabs,
          [tabId]: { ...tab, draftInserts: [...tab.draftInserts, data] },
        },
      }
    })
  },

  removeStagedInsert: (tabId: string, index: number) => {
    set((state) => {
      const tab = getOrInitTab(state.tabs, tabId)
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...tab,
            draftInserts: tab.draftInserts.filter((_, idx) => idx !== index),
          },
        },
      }
    })
  },

  clearDrafts: (tabId: string) => {
    set((state) => {
      const tab = getOrInitTab(state.tabs, tabId)
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...tab,
            draftUpdates: {},
            draftDeletes: [],
            draftInserts: [],
          },
        },
      }
    })
  },
}))
