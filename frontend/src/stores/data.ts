import { create } from 'zustand'
import { fetchWithTimeout } from '@/lib/http'
import { normalizeDataRows } from '@/lib/table'
import type {
  BulkMutateOp,
  BulkMutateResult,
  ColumnMeta,
  DataOpts,
  DataResult,
  DDLOp,
  FKRef,
  MutateOp,
  ObjectInfo,
  Schema,
  TableRow,
} from '@/types/api'

interface DraftUpdate {
  where: Record<string, unknown>
  data: Record<string, unknown>
}

interface DraftDelete {
  where: Record<string, unknown>
}

interface TabData {
  columns: ColumnMeta[]
  referencedBy: FKRef[]
  rows: TableRow[]
  total: number
  loading: boolean
  objectInfo: ObjectInfo | null
  objectInfoLoading: boolean
  error: string | null
  opts: DataOpts
  draftUpdates: Record<string, DraftUpdate>
  draftDeletes: Record<string, DraftDelete>
  draftInserts: Record<string, unknown>[]
  schemaRequestId: number
  dataRequestId: number
  objectInfoRequestId: number
}

interface DataStore {
  tabs: Record<string, TabData>
  fetchSchema: (connId: string, object: string, tabId: string) => Promise<void>
  fetchData: (connId: string, object: string, tabId: string, opts?: Partial<DataOpts>) => Promise<void>
  fetchObjectInfo: (connId: string, object: string, tabId: string) => Promise<void>
  mutate: (connId: string, op: MutateOp, tabId: string) => Promise<void>
  mutateBulk: (connId: string, op: BulkMutateOp, tabId: string) => Promise<BulkMutateResult>
  ddl: (connId: string, op: DDLOp) => Promise<void>
  setOpts: (tabId: string, opts: Partial<DataOpts>) => void
  setDraftCell: (tabId: string, rowKey: string, where: Record<string, unknown>, column: string, value: unknown) => void
  toggleDraftDelete: (tabId: string, rowKey: string, where: Record<string, unknown>, deleted: boolean) => void
  stageInsert: (tabId: string, data: Record<string, unknown>) => void
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
      referencedBy: [],
      rows: [],
      total: 0,
      loading: false,
      objectInfo: null,
      objectInfoLoading: false,
      error: null,
      opts: { ...DEFAULT_OPTS },
      draftUpdates: {},
      draftDeletes: {},
      draftInserts: [],
      schemaRequestId: 0,
      dataRequestId: 0,
      objectInfoRequestId: 0,
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

export const useDataStore = create<DataStore>((set, get) => ({
  tabs: {},

  fetchSchema: async (connId: string, object: string, tabId: string) => {
    const requestId = (() => {
      let nextRequestId = 1
      set((state) => {
        const tab = getOrInitTab(state.tabs, tabId)
        nextRequestId = tab.schemaRequestId + 1
        return {
          tabs: {
            ...state.tabs,
            [tabId]: { ...tab, schemaRequestId: nextRequestId, error: null },
          },
        }
      })
      return nextRequestId
    })()

    try {
      const res = await fetchWithTimeout(`/api/connections/${connId}/objects/${encodeURIComponent(object)}/schema`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(body.error || res.statusText)
      }
      const data: Schema = await res.json()
      set((state) => {
        const tab = getOrInitTab(state.tabs, tabId)
        if (tab.schemaRequestId !== requestId) {
          return state
        }
        return {
          tabs: {
            ...state.tabs,
            [tabId]: {
              ...tab,
              columns: data.columns,
              referencedBy: data.referenced_by ?? [],
              error: null,
            },
          },
        }
      })
    } catch (e) {
      set((state) => {
        const tab = getOrInitTab(state.tabs, tabId)
        if (tab.schemaRequestId !== requestId) {
          return state
        }
        return {
          tabs: {
            ...state.tabs,
            [tabId]: { ...tab, referencedBy: [], error: (e as Error).message },
          },
        }
      })
    }
  },

  fetchData: async (connId: string, object: string, tabId: string, partialOpts?: Partial<DataOpts>) => {
    let requestId = 1
    let opts: DataOpts = { ...DEFAULT_OPTS }

    set((state) => {
      const tab = getOrInitTab(state.tabs, tabId)
      requestId = tab.dataRequestId + 1
      opts = { ...tab.opts, ...(partialOpts ?? {}) }
      return {
        tabs: {
          ...state.tabs,
          [tabId]: { ...tab, loading: true, error: null, opts, dataRequestId: requestId },
        },
      }
    })

    const params = new URLSearchParams({
      offset: String(opts.offset),
      limit: String(opts.limit),
    })
    if (opts.order_by) {
      params.set('order_by', opts.order_by)
      params.set('order_dir', opts.order_dir)
    }
    if (opts.filters.length > 0) {
      params.set('filters', JSON.stringify(opts.filters))
    }

    try {
      const res = await fetchWithTimeout(`/api/connections/${connId}/objects/${encodeURIComponent(object)}/data?${params.toString()}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(body.error || res.statusText)
      }

      const result: DataResult = await res.json()
      const normalizedRows = normalizeDataRows(result)

      set((state) => {
        const tab = getOrInitTab(state.tabs, tabId)
        if (tab.dataRequestId !== requestId) {
          return state
        }
        return {
          tabs: {
            ...state.tabs,
            [tabId]: {
              ...tab,
              columns: result.columns ?? tab.columns,
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
        const tab = getOrInitTab(state.tabs, tabId)
        if (tab.dataRequestId !== requestId) {
          return state
        }
        return {
          tabs: {
            ...state.tabs,
            [tabId]: { ...tab, loading: false, error: (e as Error).message },
          },
        }
      })
    }
  },

  fetchObjectInfo: async (connId: string, object: string, tabId: string) => {
    const requestId = (() => {
      let nextRequestId = 1
      set((state) => {
        const tab = getOrInitTab(state.tabs, tabId)
        nextRequestId = tab.objectInfoRequestId + 1
        return {
          tabs: {
            ...state.tabs,
            [tabId]: {
              ...tab,
              objectInfoRequestId: nextRequestId,
              objectInfoLoading: true,
              error: null,
            },
          },
        }
      })
      return nextRequestId
    })()

    try {
      const res = await fetchWithTimeout(`/api/connections/${connId}/objects/${encodeURIComponent(object)}/info`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(body.error || res.statusText)
      }
      const info: ObjectInfo = await res.json()
      set((state) => {
        const tab = getOrInitTab(state.tabs, tabId)
        if (tab.objectInfoRequestId !== requestId) {
          return state
        }
        return {
          tabs: {
            ...state.tabs,
            [tabId]: {
              ...tab,
              objectInfo: info,
              objectInfoLoading: false,
              error: null,
            },
          },
        }
      })
    } catch (e) {
      set((state) => {
        const tab = getOrInitTab(state.tabs, tabId)
        if (tab.objectInfoRequestId !== requestId) {
          return state
        }
        return {
          tabs: {
            ...state.tabs,
            [tabId]: {
              ...tab,
              objectInfo: null,
              objectInfoLoading: false,
              error: (e as Error).message,
            },
          },
        }
      })
    }
  },

  mutate: async (connId: string, op: MutateOp, tabId: string) => {
    try {
      const res = await fetchWithTimeout(`/api/connections/${connId}/mutate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(op),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(body.error || res.statusText)
      }

      const currentTab = get().tabs[tabId]
      if (currentTab) {
        const fullObject = op.schema ? `${op.schema}.${op.object}` : op.object
        await get().fetchData(connId, fullObject, tabId, currentTab.opts)
      }
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
      throw e
    }
  },

  mutateBulk: async (connId: string, op: BulkMutateOp, tabId: string) => {
    try {
      const res = await fetchWithTimeout(`/api/connections/${connId}/mutate/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(op),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(body.error || res.statusText)
      }

      const result: BulkMutateResult = await res.json()
      const currentTab = get().tabs[tabId]
      if (currentTab) {
        await get().fetchData(connId, `${op.schema}.${op.object}`, tabId, currentTab.opts)
      }

      return result
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
      throw e
    }
  },

  ddl: async (connId: string, op: DDLOp) => {
    const res = await fetchWithTimeout(`/api/connections/${connId}/ddl`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(op),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error(body.error || res.statusText)
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

  setDraftCell: (tabId: string, rowKey: string, where: Record<string, unknown>, column: string, value: unknown) => {
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

  toggleDraftDelete: (tabId: string, rowKey: string, where: Record<string, unknown>, deleted: boolean) => {
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

  stageInsert: (tabId: string, data: Record<string, unknown>) => {
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
            draftInserts: tab.draftInserts.filter((_, itemIndex) => itemIndex !== index),
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
