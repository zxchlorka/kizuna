import { create } from 'zustand'
import { fetchWithTimeout } from '@/lib/http'
import type { ColumnMeta, KafkaProduceRequest, KafkaProduceResult, ObjectItem } from '@/types/api'

export interface KafkaMessageRow {
  partition: number
  offset: number
  timestamp: string
  key: string
  value: string
  format: string
  headers?: Record<string, string>
}

interface KafkaTopicTabState {
  children: ObjectItem[]
  childrenLoading: boolean
  childrenError: string | null

  messages: KafkaMessageRow[]
  messagesLoading: boolean
  loadingOlder: boolean
  messagesError: string | null
  total: number
  hasOlder: boolean
  nextBeforeOffsets: Record<string, number> | null
  partitionFilter: number | null
  searchField: string
  searchValue: string
  searchActive: boolean
  scanned: number
}

interface KafkaSearch {
  field: string
  value: string
}

interface KafkaStore {
  tabs: Record<string, KafkaTopicTabState>
  fetchTopicChildren: (connId: string, topic: string, tabId: string) => Promise<void>
  fetchMessages: (connId: string, topic: string, tabId: string) => Promise<void>
  fetchOlderMessages: (connId: string, topic: string, tabId: string) => Promise<void>
  setPartitionFilter: (connId: string, topic: string, tabId: string, partition: number | null) => Promise<void>
  setSearch: (connId: string, topic: string, tabId: string, field: string, value: string) => Promise<void>
  clearSearch: (connId: string, topic: string, tabId: string) => Promise<void>
  produce: (connId: string, request: KafkaProduceRequest) => Promise<KafkaProduceResult>
}

function defaultTabState(): KafkaTopicTabState {
  return {
    children: [],
    childrenLoading: false,
    childrenError: null,
    messages: [],
    messagesLoading: false,
    loadingOlder: false,
    messagesError: null,
    total: 0,
    hasOlder: false,
    nextBeforeOffsets: null,
    partitionFilter: null,
    searchField: '',
    searchValue: '',
    searchActive: false,
    scanned: 0,
  }
}

function ensureState(tabs: Record<string, KafkaTopicTabState>, tabId: string): KafkaTopicTabState {
  return tabs[tabId] ?? defaultTabState()
}

interface MessagesResponse {
  columns: ColumnMeta[]
  rows: KafkaMessageRow[]
  total: number
  has_more: boolean
  meta?: {
    has_older?: boolean
    next_before_offsets?: Record<string, number>
    partitions?: number
    scanning?: boolean
    scanned?: number
    matched?: number
  }
}

const kafkaChildrenRequests = new Map<string, Promise<void>>()
const kafkaMessageRequests = new Map<string, Promise<void>>()

function kafkaTopicKey(connId: string, topic: string, tabId: string): string {
  return `${tabId}::${connId}::${topic}`
}

function kafkaMessageKey(
  connId: string,
  topic: string,
  tabId: string,
  partition: number | null,
  beforeOffsets: Record<string, number> | null,
  search: KafkaSearch | null
): string {
  return `${kafkaTopicKey(connId, topic, tabId)}::${partition ?? 'all'}::${JSON.stringify(beforeOffsets ?? {})}::${search?.field ?? ''}=${search?.value ?? ''}`
}

function activeSearch(tab: KafkaTopicTabState): KafkaSearch | null {
  return tab.searchActive && tab.searchField ? { field: tab.searchField, value: tab.searchValue } : null
}

async function requestMessages(
  connId: string,
  topic: string,
  partition: number | null,
  beforeOffsets: Record<string, number> | null,
  search: KafkaSearch | null
): Promise<MessagesResponse> {
  const filters: Array<{ column: string; op: string; value: string }> = []
  if (partition !== null) {
    filters.push({ column: 'partition', op: 'eq', value: String(partition) })
  }
  if (beforeOffsets && Object.keys(beforeOffsets).length > 0) {
    filters.push({ column: 'before_offsets', op: 'eq', value: JSON.stringify(beforeOffsets) })
  }
  if (search) {
    filters.push({ column: 'match_field', op: 'eq', value: search.field })
    filters.push({ column: 'match_value', op: 'eq', value: search.value })
  }

  const params = new URLSearchParams({ limit: '50' })
  if (filters.length > 0) {
    params.set('filters', JSON.stringify(filters))
  }

  const res = await fetchWithTimeout(
    `/api/connections/${connId}/objects/${encodeURIComponent(topic)}/data?${params.toString()}`
  )
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(body.error || res.statusText)
  }
  return (await res.json()) as MessagesResponse
}

export const useKafkaStore = create<KafkaStore>((set, get) => ({
  tabs: {},

  fetchTopicChildren: async (connId, topic, tabId) => {
    const requestKey = kafkaTopicKey(connId, topic, tabId)
    const pending = kafkaChildrenRequests.get(requestKey)
    if (pending) {
      return pending
    }

    const request = (async () => {
      set((state) => ({
        tabs: {
          ...state.tabs,
          [tabId]: { ...ensureState(state.tabs, tabId), childrenLoading: true, childrenError: null },
        },
      }))
      try {
        const res = await fetchWithTimeout(`/api/connections/${connId}/objects?path=${encodeURIComponent(topic)}`)
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: res.statusText }))
          throw new Error(body.error || res.statusText)
        }
        const children = (await res.json()) as ObjectItem[]
        set((state) => ({
          tabs: {
            ...state.tabs,
            [tabId]: { ...ensureState(state.tabs, tabId), children, childrenLoading: false },
          },
        }))
      } catch (error) {
        set((state) => ({
          tabs: {
            ...state.tabs,
            [tabId]: {
              ...ensureState(state.tabs, tabId),
              childrenLoading: false,
              childrenError: (error as Error).message,
            },
          },
        }))
      } finally {
        kafkaChildrenRequests.delete(requestKey)
      }
    })()

    kafkaChildrenRequests.set(requestKey, request)
    return request
  },

  fetchMessages: async (connId, topic, tabId) => {
    const current = ensureState(get().tabs, tabId)
    const search = activeSearch(current)
    const requestKey = kafkaMessageKey(connId, topic, tabId, current.partitionFilter, null, search)
    const pending = kafkaMessageRequests.get(requestKey)
    if (pending) {
      return pending
    }

    const request = (async () => {
      set((state) => ({
        tabs: {
          ...state.tabs,
          [tabId]: { ...ensureState(state.tabs, tabId), messagesLoading: true, messagesError: null },
        },
      }))
      try {
        const data = await requestMessages(connId, topic, current.partitionFilter, null, search)
        set((state) => ({
          tabs: {
            ...state.tabs,
            [tabId]: {
              ...ensureState(state.tabs, tabId),
              messages: data.rows ?? [],
              total: data.total,
              hasOlder: Boolean(data.meta?.has_older),
              nextBeforeOffsets: data.meta?.next_before_offsets ?? null,
              scanned: data.meta?.scanned ?? 0,
              messagesLoading: false,
            },
          },
        }))
      } catch (error) {
        set((state) => ({
          tabs: {
            ...state.tabs,
            [tabId]: {
              ...ensureState(state.tabs, tabId),
              messagesLoading: false,
              messagesError: (error as Error).message,
            },
          },
        }))
      } finally {
        kafkaMessageRequests.delete(requestKey)
      }
    })()

    kafkaMessageRequests.set(requestKey, request)
    return request
  },

  fetchOlderMessages: async (connId, topic, tabId) => {
    const current = ensureState(get().tabs, tabId)
    if (!current.nextBeforeOffsets || current.loadingOlder) {
      return
    }
    const search = activeSearch(current)
    const requestKey = kafkaMessageKey(connId, topic, tabId, current.partitionFilter, current.nextBeforeOffsets, search)
    const pending = kafkaMessageRequests.get(requestKey)
    if (pending) {
      return pending
    }

    const request = (async () => {
      set((state) => ({
        tabs: {
          ...state.tabs,
          [tabId]: { ...ensureState(state.tabs, tabId), loadingOlder: true, messagesError: null },
        },
      }))
      try {
        const data = await requestMessages(connId, topic, current.partitionFilter, current.nextBeforeOffsets, search)
        set((state) => {
          const tab = ensureState(state.tabs, tabId)
          const seen = new Set(tab.messages.map((row) => `${row.partition}:${row.offset}`))
          const older = (data.rows ?? []).filter((row) => !seen.has(`${row.partition}:${row.offset}`))
          return {
            tabs: {
              ...state.tabs,
              [tabId]: {
                ...tab,
                messages: [...tab.messages, ...older],
                hasOlder: Boolean(data.meta?.has_older),
                nextBeforeOffsets: data.meta?.next_before_offsets ?? null,
                scanned: tab.scanned + (data.meta?.scanned ?? 0),
                loadingOlder: false,
              },
            },
          }
        })
      } catch (error) {
        set((state) => ({
          tabs: {
            ...state.tabs,
            [tabId]: {
              ...ensureState(state.tabs, tabId),
              loadingOlder: false,
              messagesError: (error as Error).message,
            },
          },
        }))
      } finally {
        kafkaMessageRequests.delete(requestKey)
      }
    })()

    kafkaMessageRequests.set(requestKey, request)
    return request
  },

  setPartitionFilter: async (connId, topic, tabId, partition) => {
    set((state) => ({
      tabs: {
        ...state.tabs,
        [tabId]: {
          ...ensureState(state.tabs, tabId),
          partitionFilter: partition,
          messages: [],
          nextBeforeOffsets: null,
          hasOlder: false,
        },
      },
    }))
    await get().fetchMessages(connId, topic, tabId)
  },

  setSearch: async (connId, topic, tabId, field, value) => {
    const trimmed = field.trim()
    set((state) => ({
      tabs: {
        ...state.tabs,
        [tabId]: {
          ...ensureState(state.tabs, tabId),
          searchField: trimmed,
          searchValue: value,
          searchActive: trimmed !== '',
          messages: [],
          nextBeforeOffsets: null,
          hasOlder: false,
          scanned: 0,
        },
      },
    }))
    await get().fetchMessages(connId, topic, tabId)
  },

  clearSearch: async (connId, topic, tabId) => {
    set((state) => ({
      tabs: {
        ...state.tabs,
        [tabId]: {
          ...ensureState(state.tabs, tabId),
          searchField: '',
          searchValue: '',
          searchActive: false,
          messages: [],
          nextBeforeOffsets: null,
          hasOlder: false,
          scanned: 0,
        },
      },
    }))
    await get().fetchMessages(connId, topic, tabId)
  },

  produce: async (connId, request) => {
    const res = await fetchWithTimeout(
      `/api/connections/${connId}/produce`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      },
      30000
    )
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error(body.error || res.statusText)
    }
    return (await res.json()) as KafkaProduceResult
  },
}))
