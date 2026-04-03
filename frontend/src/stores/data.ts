import { create } from 'zustand'
import type {
  BulkMutateOp,
  BulkMutateResult,
  ColumnMeta,
  DataOpts,
  DataResult,
  MutateOp,
} from '@/types/api'

interface DraftUpdate {
  where: Record<string, any>
  data: Record<string, any>
}

interface DraftDelete {
  where: Record<string, any>
}

interface TabData {
  columns: ColumnMeta[]
  rows: any[][]
  total: number
  loading: boolean
  error: string | null
  opts: DataOpts
  draftUpdates: Record<string, DraftUpdate>
  draftDeletes: Record<string, DraftDelete>
  draftInserts: Record<string, any>[]
}

interface DataStore {
  tabs: Record<string, TabData>
  fetchSchema: (connId: string, object: string, tabId: string) => Promise<void>
  fetchData: (connId: string, object: string, tabId: string, opts?: Partial<DataOpts>) => Promise<void>
  mutate: (connId: string, op: MutateOp, tabId: string) => Promise<void>
  mutateBulk: (connId: string, op: BulkMutateOp, tabId: string) => Promise<BulkMutateResult>
  setOpts: (tabId: string, opts: Partial<DataOpts>) => void
  setDraftCell: (tabId: string, rowKey: string, where: Record<string, any>, column: string, value: any) => void
  toggleDraftDelete: (tabId: string, rowKey: string, where: Record<string, any>, deleted: boolean) => void
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

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
      draftDeletes: {},
      draftInserts: [],
    }
  )
}

function cloneDraftUpdates(updates: Record<string, DraftUpdate>): Record<string, DraftUpdate> {
  const next: Record<string, DraftUpdate> = {}
  Object.entries(updates).forEach(([rowKey, draft]) => {
    next[rowKey] = { where: { ...draft.where }, data: { ...draft.data } }
  })
  return next
}

function cloneDraftDeletes(deletes: Record<string, DraftDelete>): Record<string, DraftDelete> {
  const next: Record<string, DraftDelete> = {}
  Object.entries(deletes).forEach(([rowKey, draft]) => {
    next[rowKey] = { where: { ...draft.where } }
  })
  return next
}

function normalizeUUIDString(value: string): string | null {
  const trimmed = value.trim()
  if (UUID_RE.test(trimmed)) {
    return trimmed.toLowerCase()
  }
  return null
}

function normalizeUUIDCell(value: unknown): unknown {
  if (typeof value === 'string') {
    return normalizeUUIDString(value) ?? value
  }

  return value
}

function normalizeRows(result: DataResult): any[][] {
  if (!result.rows || result.rows.length === 0 || !result.columns || result.columns.length === 0) {
    return result.rows ?? []
  }

  return result.rows.map((row) =>
    row.map((value, idx) => {
      const col = result.columns[idx]
      if (!col) return value
      if (col.data_type.toLowerCase() !== 'uuid') return value
      return normalizeUUIDCell(value)
    })
  )
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
      const normalizedRows = normalizeRows(result)
      set((state) => {
        const current = getOrInitTab(state.tabs, tabId)
        return {
          tabs: {
            ...state.tabs,
            [tabId]: {
              ...current,
              columns: result.columns ?? current.columns,
              rows: normalizedRows,
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

  setDraftCell: (tabId: string, rowKey: string, where: Record<string, any>, column: string, value: any) => {
    set((state) => {
      const tab = getOrInitTab(state.tabs, tabId)
      const nextUpdates = cloneDraftUpdates(tab.draftUpdates)
      const rowDraft = nextUpdates[rowKey] ?? { where: { ...where }, data: {} }
      rowDraft.where = { ...where }
      rowDraft.data = { ...rowDraft.data, [column]: value }
      nextUpdates[rowKey] = rowDraft
      return {
        tabs: {
          ...state.tabs,
          [tabId]: { ...tab, draftUpdates: nextUpdates },
        },
      }
    })
  },

  toggleDraftDelete: (tabId: string, rowKey: string, where: Record<string, any>, deleted: boolean) => {
    set((state) => {
      const tab = getOrInitTab(state.tabs, tabId)
      const nextDeletes = cloneDraftDeletes(tab.draftDeletes)
      const nextUpdates = cloneDraftUpdates(tab.draftUpdates)

      if (deleted) {
        nextDeletes[rowKey] = { where: { ...where } }
        delete nextUpdates[rowKey]
      } else {
        delete nextDeletes[rowKey]
      }

      return {
        tabs: {
          ...state.tabs,
          [tabId]: { ...tab, draftDeletes: nextDeletes, draftUpdates: nextUpdates },
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
            draftDeletes: {},
            draftInserts: [],
          },
        },
      }
    })
  },
}))
