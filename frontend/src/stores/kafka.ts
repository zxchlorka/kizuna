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
}

interface KafkaStore {
  tabs: Record<string, KafkaTopicTabState>
  fetchTopicChildren: (connId: string, topic: string, tabId: string) => Promise<void>
  fetchMessages: (connId: string, topic: string, tabId: string) => Promise<void>
  fetchOlderMessages: (connId: string, topic: string, tabId: string) => Promise<void>
  setPartitionFilter: (connId: string, topic: string, tabId: string, partition: number | null) => Promise<void>
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
  }
}

async function requestMessages(
  connId: string,
  topic: string,
  partition: number | null,
  beforeOffsets: Record<string, number> | null
): Promise<MessagesResponse> {
  const filters: Array<{ column: string; op: string; value: string }> = []
  if (partition !== null) {
    filters.push({ column: 'partition', op: 'eq', value: String(partition) })
  }
  if (beforeOffsets && Object.keys(beforeOffsets).length > 0) {
    filters.push({ column: 'before_offsets', op: 'eq', value: JSON.stringify(beforeOffsets) })
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
    }
  },

  fetchMessages: async (connId, topic, tabId) => {
    const current = ensureState(get().tabs, tabId)
    set((state) => ({
      tabs: {
        ...state.tabs,
        [tabId]: { ...ensureState(state.tabs, tabId), messagesLoading: true, messagesError: null },
      },
    }))
    try {
      const data = await requestMessages(connId, topic, current.partitionFilter, null)
      set((state) => ({
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...ensureState(state.tabs, tabId),
            messages: data.rows ?? [],
            total: data.total,
            hasOlder: Boolean(data.meta?.has_older),
            nextBeforeOffsets: data.meta?.next_before_offsets ?? null,
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
    }
  },

  fetchOlderMessages: async (connId, topic, tabId) => {
    const current = ensureState(get().tabs, tabId)
    if (!current.nextBeforeOffsets || current.loadingOlder) {
      return
    }

    set((state) => ({
      tabs: {
        ...state.tabs,
        [tabId]: { ...ensureState(state.tabs, tabId), loadingOlder: true, messagesError: null },
      },
    }))
    try {
      const data = await requestMessages(connId, topic, current.partitionFilter, current.nextBeforeOffsets)
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
    }
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
