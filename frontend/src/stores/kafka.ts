import { create } from 'zustand'
import { fetchWithTimeout, RequestAbortedError } from '@/lib/http'
import { matchField } from '@/lib/jsonPaths'
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
  // Browse anchor — see KafkaSeek. Persisted on the tab so Refresh and
  // "Load older" keep reading from the same starting point.
  seekOffset: string
  seekTimestamp: string

  // "Filter loaded" — a pure client-side predicate over the already-loaded raw
  // `messages`, run in the browser with zero network requests. It never touches
  // `nextBeforeOffsets`/`hasOlder`; the visible rows are derived from `messages`
  // + this predicate (see filterLoadedMessages), so clearing it restores the
  // page and cursor instantly because they were never mutated.
  filterField: string
  filterValue: string
  filterActive: boolean

  // "Search topic" — the budgeted BACKEND scan (match_field/match_value ->
  // messages.go). Each step scans one window under the reader's scan budget and
  // returns whatever it matched plus a cursor to continue deeper. `messages`
  // holds the accumulated matches while a search session is active.
  searchField: string
  searchValue: string
  searchActive: boolean
  scanning: boolean
  scanned: number
  // A scan STEP hit its backend budget before finishing its window (meta
  // partial_scan). Deliberately SEPARATE from the browse-coverage `partial`
  // field below so the two "partial" concepts never smear into one ambiguous
  // flag — one drives the "Scan more"/scanned UI, the other the amber coverage
  // banner.
  scanPartial: boolean

  // Coverage/partial-result state for the normal (non-search) browse path —
  // see MessagesResponse.meta. The search/scan path never writes these; it has
  // its own scanned/scanPartial state above.
  partial: boolean
  partialReason: string | null
  partitionsTotal: number
  partitionsCompleted: number
  messagesReturned: number
}

interface KafkaSearch {
  field: string
  value: string
}

// Where a browse starts reading, the reader's equivalent of Kafka UI's "Seek
// Type". Both forms name the newest message a page may show and the reader walks
// backwards from there — the only direction it reads. A seek is orthogonal to
// the field search: it narrows WHICH PART of the log is read, the search narrows
// WHICH of those messages are shown, and the two combine.
export interface KafkaSeek {
  // Raw user input, '' when unset. Only meaningful with a single partition
  // selected; the backend rejects it otherwise, because offsets are not
  // comparable across partitions.
  offset: string
  // RFC3339, '' when unset. Resolves independently inside each partition, so it
  // works at any partition scope.
  timestamp: string
}

function seekIsSet(seek: KafkaSeek | null | undefined): seek is KafkaSeek {
  return Boolean(seek && (seek.offset.trim() !== '' || seek.timestamp.trim() !== ''))
}

// Tolerates a tab that predates these fields: ensureState only fills defaults
// for a tab it has never seen, so a partially-populated existing tab (which is
// how the store tests inject state) would otherwise read undefined here.
function seekOf(tab: { seekOffset?: string; seekTimestamp?: string }): KafkaSeek | null {
  const seek = { offset: tab.seekOffset ?? '', timestamp: tab.seekTimestamp ?? '' }
  return seekIsSet(seek) ? seek : null
}

interface KafkaStore {
  tabs: Record<string, KafkaTopicTabState>
  fetchTopicChildren: (connId: string, topic: string, tabId: string) => Promise<void>
  // Mount-time initial load. Guards an active search from being browse-clobbered
  // when KafkaTopicView remounts (see implementation). Prefer this over
  // fetchMessages for the view's mount effect; use fetchMessages for explicit
  // browse refresh/produce paths.
  loadInitialMessages: (connId: string, topic: string, tabId: string) => Promise<void>
  fetchMessages: (connId: string, topic: string, tabId: string) => Promise<void>
  // Explicit user "Refresh" of the current view (header + toolbar buttons, the
  // produce-then-refresh path). Search-aware: if a "Search topic" session is
  // active for this tab, re-run that search from the top (a fresh first step
  // with the tab's existing searchField/searchValue) instead of browse-
  // overwriting the accumulated scan matches/cursor; otherwise reload the
  // newest browse page via fetchMessages. Restores the pre-Task-7 intent
  // (Refresh keeps you looking at the same kind of thing) on top of the new
  // browse/search separation.
  refreshMessages: (connId: string, topic: string, tabId: string) => Promise<void>
  fetchOlderMessages: (connId: string, topic: string, tabId: string) => Promise<void>
  setPartitionFilter: (connId: string, topic: string, tabId: string, partition: number | null) => Promise<void>
  // Move the browse anchor (see KafkaSeek). Reloads from the new starting point;
  // an active "Search topic" session is re-run from there rather than dropped,
  // because a seek narrows the range a search covers rather than replacing it.
  setSeek: (connId: string, topic: string, tabId: string, seek: KafkaSeek) => Promise<void>
  // Filter loaded (client-side, no network).
  setLoadedFilter: (tabId: string, field: string, value: string) => void
  clearLoadedFilter: (tabId: string) => void
  // Search topic (budgeted backend scan).
  searchTopic: (connId: string, topic: string, tabId: string, field: string, value: string) => Promise<void>
  scanMore: (connId: string, topic: string, tabId: string) => Promise<void>
  cancelScan: (tabId: string) => void
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
    seekOffset: '',
    seekTimestamp: '',
    filterField: '',
    filterValue: '',
    filterActive: false,
    searchField: '',
    searchValue: '',
    searchActive: false,
    scanning: false,
    scanned: 0,
    scanPartial: false,
    partial: false,
    partialReason: null,
    partitionsTotal: 0,
    partitionsCompleted: 0,
    messagesReturned: 0,
  }
}

function ensureState(tabs: Record<string, KafkaTopicTabState>, tabId: string): KafkaTopicTabState {
  return tabs[tabId] ?? defaultTabState()
}

// filterLoadedMessages applies a client-side predicate over already-loaded rows.
// It is the "Filter loaded" operation's whole logic: an empty path matches
// everything (no filtering), otherwise a row survives when its JSON value has a
// leaf at the canonical path equal to `value`, using the STRICT root-anchored
// matcher shared with the Go backend's fixture set (see jsonPaths.matchField).
// Non-JSON rows never match a non-empty path and are filtered out. Pure and
// side-effect free, so the caller derives the visible set without ever mutating
// the raw `messages`/cursor state.
export function filterLoadedMessages(
  messages: KafkaMessageRow[],
  field: string,
  value: string
): KafkaMessageRow[] {
  const path = field.trim()
  if (path === '') return messages
  return messages.filter((row) => matchField(row.value, path, value))
}

interface MessagesResponse {
  columns: ColumnMeta[]
  rows: KafkaMessageRow[]
  total: number
  has_more: boolean
  meta?: {
    has_older?: boolean
    next_before_offsets?: Record<string, number>
    // partitions_total/partitions_completed count only the SCOPED partitions
    // for the current filter (1 when a single partition is selected).
    // partitions_completed can be < partitions_total even when partial is
    // false — fully-drained/empty partitions below the cursor simply aren't
    // counted as "responded". Never derive UI state by comparing these two
    // yourself; drive it off `partial` instead.
    partitions_total?: number
    partitions_completed?: number
    candidates_read?: number
    elapsed_ms?: number
    // Normal browse path only (no match_field/match_value filters active).
    partial?: boolean
    partial_reason?: string
    messages_returned?: number
    // Set when the backend detected the topic was deleted and recreated under the
    // same name mid-session and recovered by purging its stale topic id. The rows
    // belong to a NEW incarnation whose offsets restart, so an in-progress page
    // must be replaced rather than appended to.
    cursor_reset?: boolean
    // Content-search (scanning) path only — see match_field/match_value in
    // requestMessages. Unrelated to partial/messages_returned above.
    // `scanned` counts candidates inspected in the step; `matched` counts hits
    // (== rows.length); `partial_scan` marks a step that hit its budget before
    // finishing its window.
    scanning?: boolean
    scanned?: number
    matched?: number
    partial_scan?: boolean
  }
}

const kafkaChildrenRequests = new Map<string, Promise<void>>()
const kafkaMessageRequests = new Map<string, Promise<void>>()
// In-flight "Search topic" scan step per tab. Kept out of the reactive store so
// Cancel can abort the underlying HTTP request directly (see cancelScan).
const kafkaScanControllers = new Map<string, AbortController>()

function kafkaTopicKey(connId: string, topic: string, tabId: string): string {
  return `${tabId}::${connId}::${topic}`
}

function kafkaMessageKey(
  connId: string,
  topic: string,
  tabId: string,
  partition: number | null,
  beforeOffsets: Record<string, number> | null
): string {
  return `${kafkaTopicKey(connId, topic, tabId)}::${partition ?? 'all'}::${JSON.stringify(beforeOffsets ?? {})}`
}

async function requestMessages(
  connId: string,
  topic: string,
  partition: number | null,
  beforeOffsets: Record<string, number> | null,
  search: KafkaSearch | null,
  seek: KafkaSeek | null,
  signal?: AbortSignal
): Promise<MessagesResponse> {
  const filters: Array<{ column: string; op: string; value: string }> = []
  if (partition !== null) {
    filters.push({ column: 'partition', op: 'eq', value: String(partition) })
  }
  if (beforeOffsets && Object.keys(beforeOffsets).length > 0) {
    filters.push({ column: 'before_offsets', op: 'eq', value: JSON.stringify(beforeOffsets) })
  }
  // Sent alongside before_offsets rather than instead of it: the seek fixes
  // where paging starts, the cursor tracks how far down it has walked, and the
  // backend takes whichever bound is tighter.
  if (seekIsSet(seek)) {
    if (seek.offset.trim() !== '') {
      filters.push({ column: 'from_offset', op: 'eq', value: seek.offset.trim() })
    }
    if (seek.timestamp.trim() !== '') {
      filters.push({ column: 'from_timestamp', op: 'eq', value: seek.timestamp.trim() })
    }
  }
  if (search) {
    filters.push({ column: 'match_field', op: 'eq', value: search.field })
    filters.push({ column: 'match_value', op: 'eq', value: search.value })
  }

  const params = new URLSearchParams({ limit: '100' })
  if (filters.length > 0) {
    params.set('filters', JSON.stringify(filters))
  }

  const res = await fetchWithTimeout(
    `/api/connections/${connId}/objects/${encodeURIComponent(topic)}/data?${params.toString()}`,
    undefined,
    search ? 22000 : 18000,
    signal
  )
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(body.error || res.statusText)
  }
  return (await res.json()) as MessagesResponse
}

export const useKafkaStore = create<KafkaStore>((set, get) => {
  // runScanStep drives one "Search topic" backend scan window. `reset` starts a
  // fresh search (clears the accumulated matches/cursor); otherwise it's a "Scan
  // more" continuation from the current cursor. Either way it merges the step's
  // matches even when the step reports partial_scan, so a budget-limited step
  // never discards what it already found.
  const runScanStep = async (connId: string, topic: string, tabId: string, reset: boolean): Promise<void> => {
    const current = ensureState(get().tabs, tabId)
    if (current.scanning) return
    if (!reset && (!current.hasOlder || !current.nextBeforeOffsets)) return

    const search: KafkaSearch = { field: current.searchField, value: current.searchValue }
    const beforeOffsets = reset ? null : current.nextBeforeOffsets

    // Supersede any lingering controller and register this step's own so Cancel
    // aborts exactly this in-flight request.
    kafkaScanControllers.get(tabId)?.abort()
    const controller = new AbortController()
    kafkaScanControllers.set(tabId, controller)

    set((state) => {
      const tab = ensureState(state.tabs, tabId)
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...tab,
            scanning: true,
            messagesError: null,
            ...(reset
              ? { messages: [], scanned: 0, scanPartial: false, nextBeforeOffsets: null, hasOlder: false }
              : {}),
          },
        },
      }
    })

    try {
      const data = await requestMessages(connId, topic, current.partitionFilter, beforeOffsets, search, seekOf(current), controller.signal)
      set((state) => {
        const tab = ensureState(state.tabs, tabId)
        const base = reset ? [] : tab.messages
        const seen = new Set(base.map((row) => `${row.partition}:${row.offset}`))
        const matches = (data.rows ?? []).filter((row) => !seen.has(`${row.partition}:${row.offset}`))
        return {
          tabs: {
            ...state.tabs,
            [tabId]: {
              ...tab,
              messages: [...base, ...matches],
              scanned: (reset ? 0 : tab.scanned) + (data.meta?.scanned ?? 0),
              scanPartial: Boolean(data.meta?.partial_scan),
              hasOlder: Boolean(data.meta?.has_older),
              nextBeforeOffsets: data.meta?.next_before_offsets ?? null,
              scanning: false,
            },
          },
        }
      })
    } catch (error) {
      if (error instanceof RequestAbortedError) {
        // Deliberate Cancel: keep the matches accumulated so far, just stop.
        set((state) => ({
          tabs: { ...state.tabs, [tabId]: { ...ensureState(state.tabs, tabId), scanning: false } },
        }))
        return
      }
      set((state) => ({
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...ensureState(state.tabs, tabId),
            scanning: false,
            messagesError: (error as Error).message,
          },
        },
      }))
    } finally {
      if (kafkaScanControllers.get(tabId) === controller) {
        kafkaScanControllers.delete(tabId)
      }
    }
  }

  return {
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

    // loadInitialMessages is the mount-time "initial load" trigger for a topic
    // tab (KafkaTopicView's mount effect). It is deliberately SEPARATE from
    // fetchMessages because Zustand tab state outlives the component: DataViewPage
    // renders KafkaTopicView only for the active tab, so it REMOUNTS on every tab
    // switch. If the mount always browse-fetched, a tab already holding an active
    // "Search topic" session (searchActive) would have its accumulated scan
    // matches/cursor silently overwritten by a fresh browse page while the search
    // header/scanned/next_before_offsets kept describing the old scan — the
    // regression this guards against.
    //
    // Guard: if a search session is already active for this tab, leave it fully
    // untouched and fetch nothing; otherwise load the newest browse page exactly
    // as fetchMessages does. A brand-new tab has searchActive=false (ensureState
    // synthesizes a default only for reading; it is never persisted), so its
    // first-page priority load (Task 4) is unaffected. The link-jump flow is
    // covered too: useOpenLinkTarget/useOpenLinkSource call searchTopic, which
    // sets searchActive synchronously before React commits the mount and runs
    // this effect, so the mount sees the active search and skips the browse.
    loadInitialMessages: async (connId, topic, tabId) => {
      if (ensureState(get().tabs, tabId).searchActive) return
      await get().fetchMessages(connId, topic, tabId)
    },

    // fetchMessages loads the newest browse page. It is browse-only: content
    // search runs through searchTopic/scanMore, never here, so a "Search topic"
    // session and a plain page load can never contend for the same state.
    fetchMessages: async (connId, topic, tabId) => {
      const current = ensureState(get().tabs, tabId)
      const requestKey = kafkaMessageKey(connId, topic, tabId, current.partitionFilter, null)
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
          const data = await requestMessages(connId, topic, current.partitionFilter, null, null, seekOf(current))
          set((state) => ({
            tabs: {
              ...state.tabs,
              [tabId]: {
                ...ensureState(state.tabs, tabId),
                messages: data.rows ?? [],
                total: data.total,
                hasOlder: Boolean(data.meta?.has_older),
                nextBeforeOffsets: data.meta?.next_before_offsets ?? null,
                partial: Boolean(data.meta?.partial),
                partialReason: data.meta?.partial_reason ?? null,
                partitionsTotal: data.meta?.partitions_total ?? 0,
                partitionsCompleted: data.meta?.partitions_completed ?? 0,
                messagesReturned: data.meta?.messages_returned ?? 0,
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

    // refreshMessages is the explicit user "Refresh" of the current view. Before
    // Task 7, the single fetchMessages was search-aware and a Refresh during an
    // active search correctly RE-RAN the search; Task 7's split made fetchMessages
    // strictly browse-only, so a bare fetchMessages here would silently replace an
    // active search's matches/cursor with unrelated browse rows while leaving
    // searchActive/scanned/"Scanned N · M matches" stale (the same corruption
    // class the mount-path guard fixes, reached via an explicit click). Route the
    // decision through searchActive: re-run the search from the top when one is
    // active, otherwise browse-refresh. This restores the old intent using the new
    // clean searchTopic/fetchMessages separation — no reintroduced muddled fetch.
    refreshMessages: async (connId, topic, tabId) => {
      const current = ensureState(get().tabs, tabId)
      if (current.searchActive) {
        await get().searchTopic(connId, topic, tabId, current.searchField, current.searchValue)
        return
      }
      await get().fetchMessages(connId, topic, tabId)
    },

    // fetchOlderMessages loads the next older browse page and appends it. A
    // client-side "Filter loaded" predicate simply re-derives over the enlarged
    // raw set, so loading older while filtering surfaces more matches.
    fetchOlderMessages: async (connId, topic, tabId) => {
      const current = ensureState(get().tabs, tabId)
      if (!current.nextBeforeOffsets || current.loadingOlder) {
        return
      }
      const requestKey = kafkaMessageKey(connId, topic, tabId, current.partitionFilter, current.nextBeforeOffsets)
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
          const data = await requestMessages(connId, topic, current.partitionFilter, current.nextBeforeOffsets, null, seekOf(current))
          set((state) => {
            const tab = ensureState(state.tabs, tabId)
            // On cursor_reset the rows on screen came from a topic incarnation that
            // no longer exists; their (partition, offset) identities collide with the
            // new topic's but denote different records, so dedup-and-append would
            // interleave two unrelated topics. Replace instead.
            const recreated = Boolean(data.meta?.cursor_reset)
            const seen = new Set(recreated ? [] : tab.messages.map((row) => `${row.partition}:${row.offset}`))
            const older = (data.rows ?? []).filter((row) => !seen.has(`${row.partition}:${row.offset}`))
            return {
              tabs: {
                ...state.tabs,
                [tabId]: {
                  ...tab,
                  messages: recreated ? older : [...tab.messages, ...older],
                  hasOlder: Boolean(data.meta?.has_older),
                  nextBeforeOffsets: data.meta?.next_before_offsets ?? null,
                  partial: Boolean(data.meta?.partial),
                  partialReason: data.meta?.partial_reason ?? null,
                  partitionsTotal: data.meta?.partitions_total ?? 0,
                  partitionsCompleted: data.meta?.partitions_completed ?? 0,
                  messagesReturned: data.meta?.messages_returned ?? 0,
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
      // Changing partition scope is a fresh browse of that scope: abort any scan
      // and drop both the search session and the client-side filter so the view
      // is unambiguous.
      kafkaScanControllers.get(tabId)?.abort()
      set((state) => ({
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...ensureState(state.tabs, tabId),
            partitionFilter: partition,
            // An offset seek is only meaningful within one partition, and the
            // backend rejects it otherwise — so widening back to all partitions
            // drops it rather than leaving the view stuck on an error. The
            // timestamp seek resolves per partition and survives.
            ...(partition === null ? { seekOffset: '' } : {}),
            messages: [],
            nextBeforeOffsets: null,
            hasOlder: false,
            filterField: '',
            filterValue: '',
            filterActive: false,
            searchField: '',
            searchValue: '',
            searchActive: false,
            scanning: false,
            scanned: 0,
            scanPartial: false,
            partial: false,
            partialReason: null,
            partitionsTotal: 0,
            partitionsCompleted: 0,
            messagesReturned: 0,
          },
        },
      }))
      await get().fetchMessages(connId, topic, tabId)
    },

    setSeek: async (connId, topic, tabId, seek) => {
      // A seek re-anchors the whole view, so the accumulated page and its cursor
      // are no longer valid. The search session is deliberately KEPT: seeking
      // narrows where a search looks, so dropping it would undo the composition
      // the two are meant to have.
      kafkaScanControllers.get(tabId)?.abort()
      const previous = ensureState(get().tabs, tabId)
      set((state) => ({
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...ensureState(state.tabs, tabId),
            seekOffset: seek.offset,
            seekTimestamp: seek.timestamp,
            messages: [],
            nextBeforeOffsets: null,
            hasOlder: false,
            scanning: false,
            scanned: 0,
            scanPartial: false,
            partial: false,
            partialReason: null,
            partitionsTotal: 0,
            partitionsCompleted: 0,
            messagesReturned: 0,
          },
        },
      }))
      if (previous.searchActive && previous.searchField) {
        await get().searchTopic(connId, topic, tabId, previous.searchField, previous.searchValue)
        return
      }
      await get().fetchMessages(connId, topic, tabId)
    },

    setLoadedFilter: (tabId, field, value) => {
      const trimmed = field.trim()
      set((state) => ({
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...ensureState(state.tabs, tabId),
            filterField: trimmed,
            filterValue: value,
            filterActive: trimmed !== '',
          },
        },
      }))
    },

    clearLoadedFilter: (tabId) => {
      set((state) => ({
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...ensureState(state.tabs, tabId),
            filterField: '',
            filterValue: '',
            filterActive: false,
          },
        },
      }))
    },

    searchTopic: async (connId, topic, tabId, field, value) => {
      const trimmed = field.trim()
      if (trimmed === '') return
      set((state) => ({
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...ensureState(state.tabs, tabId),
            searchField: trimmed,
            searchValue: value,
            searchActive: true,
            // A topic scan replaces the loaded view with its matches; drop any
            // client-side filter so the two operations never stack on one set.
            filterField: '',
            filterValue: '',
            filterActive: false,
          },
        },
      }))
      await runScanStep(connId, topic, tabId, true)
    },

    scanMore: async (connId, topic, tabId) => {
      await runScanStep(connId, topic, tabId, false)
    },

    cancelScan: (tabId) => {
      // Abort the in-flight HTTP request (not just stop the next step). The
      // aborted request's handler flips `scanning` off and keeps the matches
      // found so far; set it here too so the UI reacts immediately.
      kafkaScanControllers.get(tabId)?.abort()
      set((state) => ({
        tabs: { ...state.tabs, [tabId]: { ...ensureState(state.tabs, tabId), scanning: false } },
      }))
    },

    clearSearch: async (connId, topic, tabId) => {
      kafkaScanControllers.get(tabId)?.abort()
      set((state) => ({
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...ensureState(state.tabs, tabId),
            searchField: '',
            searchValue: '',
            searchActive: false,
            scanning: false,
            scanned: 0,
            scanPartial: false,
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
  }
})
