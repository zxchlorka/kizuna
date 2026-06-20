import { create } from 'zustand'
import { fetchWithTimeout } from '@/lib/http'
import { normalizeDataRows, normalizeFilters } from '@/lib/table'
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
  ObjectType,
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
  hasMore: boolean
  loading: boolean
  objectInfo: ObjectInfo | null
  objectInfoLoading: boolean
  error: string | null
  schemaError: string | null
  dataError: string | null
  mutationError: string | null
  objectInfoError: string | null
  meta: Record<string, unknown> | null
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
  resolveObjectType: (connId: string, object: string) => Promise<ObjectType>
  mutate: (connId: string, op: MutateOp, tabId: string, options?: { reload?: boolean }) => Promise<void>
  mutateBulk: (connId: string, op: BulkMutateOp, tabId: string, options?: { reload?: boolean }) => Promise<BulkMutateResult>
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
      hasMore: false,
      loading: false,
      objectInfo: null,
      objectInfoLoading: false,
      error: null,
      schemaError: null,
      dataError: null,
      mutationError: null,
      objectInfoError: null,
      meta: null,
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

const schemaRequests = new Map<string, Promise<void>>()
const dataRequests = new Map<string, Promise<void>>()
const objectInfoRequests = new Map<string, Promise<void>>()

function dataOptsSignature(opts: DataOpts): string {
  return JSON.stringify({
    offset: opts.offset,
    limit: opts.limit,
    order_by: opts.order_by,
    order_dir: opts.order_dir,
    filters: normalizeFilters(opts.filters ?? []),
  })
}

function schemaRequestKey(connId: string, object: string, tabId: string): string {
  return `${tabId}::${connId}::${object}`
}

function dataRequestKey(connId: string, object: string, tabId: string, opts: DataOpts): string {
  return `${schemaRequestKey(connId, object, tabId)}::${dataOptsSignature(opts)}`
}

export const useDataStore = create<DataStore>((set, get) => ({
  tabs: {},

  fetchSchema: async (connId: string, object: string, tabId: string) => {
    const requestKey = schemaRequestKey(connId, object, tabId)
    const pending = schemaRequests.get(requestKey)
    if (pending) {
      return pending
    }

    const requestId = (() => {
      let nextRequestId = 1
      set((state) => {
        const tab = getOrInitTab(state.tabs, tabId)
        nextRequestId = tab.schemaRequestId + 1
        return {
          tabs: {
            ...state.tabs,
            [tabId]: { ...tab, schemaRequestId: nextRequestId, schemaError: null },
          },
        }
      })
      return nextRequestId
    })()

    const request = (async () => {
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
                meta: data.meta ?? tab.meta,
                schemaError: null,
                error: tab.dataError ?? tab.mutationError,
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
              [tabId]: { ...tab, referencedBy: [], schemaError: (e as Error).message },
            },
          }
        })
      } finally {
        schemaRequests.delete(requestKey)
      }
    })()

    schemaRequests.set(requestKey, request)
    return request
  },

  fetchData: async (connId: string, object: string, tabId: string, partialOpts?: Partial<DataOpts>) => {
    const currentTab = getOrInitTab(get().tabs, tabId)
    const opts: DataOpts = { ...currentTab.opts, ...(partialOpts ?? {}) }
    const requestKey = dataRequestKey(connId, object, tabId, opts)
    const pending = dataRequests.get(requestKey)
    if (pending) {
      return pending
    }

    let requestId = 1
    set((state) => {
      const tab = getOrInitTab(state.tabs, tabId)
      requestId = tab.dataRequestId + 1
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...tab,
            loading: true,
            error: null,
            dataError: null,
            mutationError: null,
            opts,
            dataRequestId: requestId,
          },
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

    const request = (async () => {
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
                hasMore: Boolean(result.has_more),
                loading: false,
                meta: result.meta ?? tab.meta,
                dataError: null,
                mutationError: null,
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
          const message = (e as Error).message
          return {
            tabs: {
              ...state.tabs,
              [tabId]: { ...tab, loading: false, dataError: message, error: message },
            },
          }
        })
      } finally {
        dataRequests.delete(requestKey)
      }
    })()

    dataRequests.set(requestKey, request)
    return request
  },

  fetchObjectInfo: async (connId: string, object: string, tabId: string) => {
    const requestKey = `${schemaRequestKey(connId, object, tabId)}::info`
    const pending = objectInfoRequests.get(requestKey)
    if (pending) {
      return pending
    }

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
              objectInfoError: null,
            },
          },
        }
      })
      return nextRequestId
    })()

    const request = (async () => {
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
                objectInfoError: null,
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
                objectInfoError: (e as Error).message,
              },
            },
          }
        })
      } finally {
        objectInfoRequests.delete(requestKey)
      }
    })()

    objectInfoRequests.set(requestKey, request)
    return request
  },

  // resolveObjectType looks up a key's type before any tab exists (used to open
  // a key by exact name). It is a single O(1) round trip (TYPE+TTL via /info) and
  // does not touch tab state; throws if the key is missing or the request fails.
  resolveObjectType: async (connId: string, object: string) => {
    const res = await fetchWithTimeout(`/api/connections/${connId}/objects/${encodeURIComponent(object)}/info`)
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error(body.error || res.statusText)
    }
    const info: ObjectInfo = await res.json()
    return info.object_type
  },

  mutate: async (connId: string, op: MutateOp, tabId: string, options?: { reload?: boolean }) => {
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
      if (currentTab && options?.reload !== false) {
        const fullObject = op.schema ? `${op.schema}.${op.object}` : op.object
        await get().fetchData(connId, fullObject, tabId, currentTab.opts)
      }
    } catch (e) {
      set((state) => {
        const tab = getOrInitTab(state.tabs, tabId)
        const message = (e as Error).message
        return {
          tabs: {
            ...state.tabs,
            [tabId]: { ...tab, mutationError: message, error: message },
          },
        }
      })
      throw e
    }
  },

  mutateBulk: async (connId: string, op: BulkMutateOp, tabId: string, options?: { reload?: boolean }) => {
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
      if (currentTab && options?.reload !== false) {
        await get().fetchData(connId, `${op.schema}.${op.object}`, tabId, currentTab.opts)
      }

      return result
    } catch (e) {
      set((state) => {
        const tab = getOrInitTab(state.tabs, tabId)
        const message = (e as Error).message
        return {
          tabs: {
            ...state.tabs,
            [tabId]: { ...tab, mutationError: message, error: message },
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
