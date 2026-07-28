import { create } from 'zustand'
import { fetchWithTimeout } from '@/lib/http'
import { normalizeFilters, filtersEqual } from '@/lib/table'
import { useConnectionStore } from '@/stores/connections'
import { useDataStore } from '@/stores/data'
import type { FilterExpr, ObjectItem, ObjectPageResponse, ObjectType } from '@/types/api'

export interface NavigationTrailItem {
  tabId: string
  label: string
  filterLabel?: string
}

export interface NavigationEntry {
  fromTabId: string
  toTabId: string
  fromValue: string
  fromColumn: string
  timestamp: number
}

export interface ObjectTab {
  kind: 'object'
  id: string
  connId: string
  // Page the tab is shown on when it queries a sibling database; connId stays
  // the data source. Unset means the tab lives on its own connection's page.
  anchorConnId?: string
  object: string
  label: string
  objectType: ObjectType
  ttlSeconds?: number | null
  initialFilters?: FilterExpr[]
  navigationTrail?: NavigationTrailItem[]
}

export interface SqlTab {
  kind: 'sql'
  id: string
  connId: string
  anchorConnId?: string
  label: string
}

export interface RedisCliTab {
  kind: 'redis-cli'
  id: string
  connId: string
  anchorConnId?: string
  label: string
}

export type WorkspaceTab = ObjectTab | SqlTab | RedisCliTab

// Page a tab belongs to: its anchor when it targets a sibling database,
// otherwise its own connection.
export function tabPageId(tab: WorkspaceTab): string {
  return tab.anchorConnId ?? tab.connId
}

export interface TreeVisibility {
  showTables: boolean
  showViews: boolean
  showIndexes: boolean
}

export type TreeVisibilityKey = keyof TreeVisibility

interface WorkspaceStore {
  tabs: WorkspaceTab[]
  activeTabId: string | null
  activeTabByConnection: Record<string, string>
  openConnectionIds: string[]
  navigationHistory: NavigationEntry[]
  treeItems: Record<string, ObjectItem[]>
  treeCursors: Record<string, string>
  treeLoading: boolean
  treeLoadingByKey: Record<string, boolean>
  treeErrorByKey: Record<string, string | null>
  treeLoadedByKey: Record<string, boolean>
  treeErrorsByConnection: Record<string, string | null>
  // Scoped refresh indicator for the explicit Refresh button. Deliberately not
  // the global treeLoading flag, which another connection can turn on, and
  // deliberately separate from treeLoadingByKey so a refresh can never make a
  // consumer swap the populated tree for a skeleton.
  treeRefreshingByConnection: Record<string, boolean>
  expandedSchemas: Set<string>
  treeVisibility: TreeVisibility
  visibleSchemasByConnection: Record<string, string[] | null>
  availableSchemasByConnection: Record<string, string[]>
  selectedNodeByConnection: Record<string, string>
  treeConnByPage: Record<string, string>

  fetchTree: (connId: string, path?: string, opts?: { refresh?: boolean }) => Promise<void>
  setSelectedNode: (connId: string, node: string) => Promise<void>
  refreshTree: (connId: string) => Promise<void>
  toggleSchema: (connId: string, schema: string) => void
  setTreeVisibility: (key: TreeVisibilityKey, visible: boolean) => void
  hydrateVisibleSchemas: (connId: string, visibleSchemas: string[] | null | undefined) => void
  setVisibleSchemas: (connId: string, visibleSchemas: string[] | null) => void
  openTab: (
    connId: string,
    object: string,
    objectType?: ObjectType,
    options?: { ttlSeconds?: number | null; anchorConnId?: string }
  ) => void
  setTreeConn: (pageConnId: string, viewConnId: string) => void
  rebindSqlTab: (tabId: string, connId: string) => void
  openTabWithFilter: (connId: string, object: string, filter: FilterExpr, objectType?: ObjectType) => void
  clearObjectTabFilterState: (tabId: string) => void
  goBackFromTab: (tabId: string) => void
  openSqlTab: (connId: string) => void
  openRedisCliTab: (connId: string) => void
  closeTab: (tabId: string) => void
  setActiveTab: (tabId: string) => void
  openConnection: (connId: string) => void
  closeConnection: (connId: string) => void
  purgeConnection: (connId: string) => void
  pruneMissingConnections: (liveConnIds: string[]) => void
}

function buildFilterSignature(filters: FilterExpr[]): string {
  return JSON.stringify(normalizeFilters(filters))
}

function buildObjectTabID(connId: string, object: string, objectType: ObjectType): string {
  return `${connId}:${objectType}:${object}`
}

function buildFilteredTabID(connId: string, object: string, objectType: ObjectType, filters: FilterExpr[]): string {
  return `${buildObjectTabID(connId, object, objectType)}:filtered:${buildFilterSignature(filters)}`
}

function buildFilterLabel(filters: FilterExpr[]): string {
  return filters
    .map((filter) => (filter.value ? `${filter.column}=${filter.value}` : `${filter.column} ${filter.op}`))
    .join(', ')
}

function buildTreeKey(connId: string, path = ''): string {
  return `${connId}::${path}`
}

function parseTreeKey(key: string): { connId: string; path: string } {
  const [connId, path = ''] = key.split('::', 2)
  return { connId, path }
}

function isRedisConnection(connId: string): boolean {
  return useConnectionStore.getState().connections.find((connection) => connection.id === connId)?.type === 'redis'
}

function buildObjectsQuery(connId: string, path: string, opts: { paged: boolean; cursor?: string; node?: string }): string {
  const params = new URLSearchParams()
  if (path) params.set('path', path)
  if (opts.paged) {
    params.set('paged', '1')
    if (opts.cursor) params.set('cursor', opts.cursor)
    if (opts.node) params.set('node', opts.node)
  }
  const query = params.toString()
  return `/api/connections/${connId}/objects${query ? `?${query}` : ''}`
}

const treeRequests = new Map<string, Promise<void>>()

// Per-tree-key write sequence. Every fetch claims the next number and only
// applies its result if it is still the newest claim for that key, so a slow
// earlier response can never overwrite a newer one.
const treeFetchSeq = new Map<string, number>()

// Per-connection refresh generation, guarding the post-refresh prune and the
// refreshing indicator against an older refresh finishing last.
const treeRefreshSeq = new Map<string, number>()

function hasLoadingTreeRequests(loadingByKey: Record<string, boolean>): boolean {
  return Object.values(loadingByKey).some(Boolean)
}

// Shared by purgeConnection (one known-deleted connection) and
// pruneMissingConnections (bulk, run once on startup after the connection list
// loads: drop any restored tab whose connection doesn't exist at all -- deleted
// since the tab was last open, or restored from a different browser/config).
// Both are "forget every trace of connections matching this predicate"; only
// what counts as dead differs.
function purgeTabsWhere(state: WorkspaceStore, isConnDead: (connId: string) => boolean): Partial<WorkspaceStore> {
  const isDeadTab = (tab: WorkspaceTab) =>
    isConnDead(tab.connId) || isConnDead(tabPageId(tab)) || (tab.anchorConnId != null && isConnDead(tab.anchorConnId))
  const removedTabIds = new Set(state.tabs.filter(isDeadTab).map((tab) => tab.id))
  const remainingTabs = state.tabs.filter((tab) => !isDeadTab(tab))

  const nextActiveByConnection: Record<string, string> = {}
  Object.entries(state.activeTabByConnection).forEach(([id, tabId]) => {
    if (!isConnDead(id) && !removedTabIds.has(tabId)) {
      nextActiveByConnection[id] = tabId
    }
  })

  const nextTreeItems = { ...state.treeItems }
  const nextTreeCursors = { ...state.treeCursors }
  const nextLoadingByKey = { ...state.treeLoadingByKey }
  const nextErrorByKey = { ...state.treeErrorByKey }
  const nextLoadedByKey = { ...state.treeLoadedByKey }
  const nextExpanded = new Set<string>()
  state.expandedSchemas.forEach((key) => {
    if (!isConnDead(parseTreeKey(key).connId)) {
      nextExpanded.add(key)
    }
  })
  for (const record of [nextTreeItems, nextTreeCursors, nextLoadingByKey, nextErrorByKey, nextLoadedByKey]) {
    Object.keys(record).forEach((key) => {
      if (isConnDead(parseTreeKey(key).connId)) {
        delete (record as Record<string, unknown>)[key]
      }
    })
  }

  const dropDeadKeys = <T,>(record: Record<string, T>): Record<string, T> => {
    const next: Record<string, T> = {}
    Object.entries(record).forEach(([key, value]) => {
      if (!isConnDead(key)) {
        next[key] = value
      }
    })
    return next
  }

  // A page whose tree was switched to a dead connection loses that binding too,
  // otherwise the page would query the dead UUID on next render.
  const nextTreeConnByPage: Record<string, string> = {}
  Object.entries(state.treeConnByPage).forEach(([pageId, viewConnId]) => {
    if (!isConnDead(pageId) && !isConnDead(viewConnId)) {
      nextTreeConnByPage[pageId] = viewConnId
    }
  })

  return {
    tabs: remainingTabs,
    openConnectionIds: state.openConnectionIds.filter((id) => !isConnDead(id)),
    activeTabByConnection: nextActiveByConnection,
    activeTabId: state.activeTabId && removedTabIds.has(state.activeTabId) ? null : state.activeTabId,
    navigationHistory: state.navigationHistory.filter(
      (entry) => !removedTabIds.has(entry.fromTabId) && !removedTabIds.has(entry.toTabId)
    ),
    treeItems: nextTreeItems,
    treeCursors: nextTreeCursors,
    treeLoadingByKey: nextLoadingByKey,
    treeErrorByKey: nextErrorByKey,
    treeLoadedByKey: nextLoadedByKey,
    treeLoading: hasLoadingTreeRequests(nextLoadingByKey),
    expandedSchemas: nextExpanded,
    treeErrorsByConnection: dropDeadKeys(state.treeErrorsByConnection),
    treeRefreshingByConnection: dropDeadKeys(state.treeRefreshingByConnection),
    selectedNodeByConnection: dropDeadKeys(state.selectedNodeByConnection),
    availableSchemasByConnection: dropDeadKeys(state.availableSchemasByConnection),
    visibleSchemasByConnection: dropDeadKeys(state.visibleSchemasByConnection),
    treeConnByPage: nextTreeConnByPage,
  }
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  tabs: [],
  activeTabId: null,
  activeTabByConnection: {},
  openConnectionIds: [],
  navigationHistory: [],
  treeItems: {},
  treeCursors: {},
  treeLoading: false,
  treeLoadingByKey: {},
  treeErrorByKey: {},
  treeLoadedByKey: {},
  treeErrorsByConnection: {},
  treeRefreshingByConnection: {},
  expandedSchemas: new Set(),
  treeVisibility: {
    showTables: true,
    showViews: false,
    showIndexes: false,
  },
  visibleSchemasByConnection: {},
  availableSchemasByConnection: {},
  selectedNodeByConnection: {},
  treeConnByPage: {},

  fetchTree: async (connId: string, path?: string, opts?: { refresh?: boolean }) => {
    const normalizedPath = path || ''
    const key = buildTreeKey(connId, normalizedPath)
    const refresh = opts?.refresh === true

    // A refresh must never join an in-flight load: doing so would answer an
    // explicit user Refresh with the very response it is trying to supersede.
    if (!refresh) {
      const pending = treeRequests.get(key)
      if (pending) {
        return pending
      }
    }

    const seq = (treeFetchSeq.get(key) ?? 0) + 1
    treeFetchSeq.set(key, seq)
    const isNewest = () => treeFetchSeq.get(key) === seq

    const request = (async () => {
      // In refresh mode the loading flags are left alone so the populated tree
      // stays on screen (stale-while-revalidate); the scoped
      // treeRefreshingByConnection flag drives the button spinner instead.
      if (!refresh) {
        set((state) => {
          const loadingByKey = { ...state.treeLoadingByKey, [key]: true }
          return {
            treeLoadingByKey: loadingByKey,
            treeErrorByKey: { ...state.treeErrorByKey, [key]: null },
            treeLoading: hasLoadingTreeRequests(loadingByKey),
          }
        })
      }

      const paged = isRedisConnection(connId)
      try {
        const node = get().selectedNodeByConnection[connId]
        const res = await fetchWithTimeout(buildObjectsQuery(connId, normalizedPath, { paged, node }))
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: res.statusText }))
          throw new Error(body.error || 'Failed to fetch objects')
        }

        let items: ObjectItem[]
        let nextCursor = ''
        if (paged) {
          const page = (await res.json()) as ObjectPageResponse
          items = page.objects ?? []
          nextCursor = page.next_cursor ?? ''
        } else {
          items = await res.json()
        }

        // A superseded response is discarded entirely rather than written and
        // then corrected, so the tree never flashes stale content.
        if (!isNewest()) {
          return
        }

        set((state) => {
          const loadingByKey = { ...state.treeLoadingByKey, [key]: false }
          return {
            treeItems: { ...state.treeItems, [key]: items },
            treeCursors: { ...state.treeCursors, [key]: nextCursor },
            treeLoadingByKey: loadingByKey,
            treeErrorByKey: { ...state.treeErrorByKey, [key]: null },
            treeLoadedByKey: { ...state.treeLoadedByKey, [key]: true },
            treeErrorsByConnection: {
              ...state.treeErrorsByConnection,
              [connId]: null,
            },
            availableSchemasByConnection: normalizedPath
              ? state.availableSchemasByConnection
              : {
                  ...state.availableSchemasByConnection,
                  [connId]: items
                    .filter((item) => item.type === 'schema')
                    .map((item) => item.name),
                },
            treeLoading: hasLoadingTreeRequests(loadingByKey),
          }
        })
      } catch (error) {
        if (!isNewest()) {
          return
        }

        set((state) => {
          const loadingByKey = { ...state.treeLoadingByKey, [key]: false }
          return {
            treeLoadingByKey: loadingByKey,
            treeErrorByKey: { ...state.treeErrorByKey, [key]: (error as Error).message },
            // A failed refresh must not mark a populated key as unloaded, or the
            // tree would fall back to a skeleton and lose the visible rows.
            treeLoadedByKey: refresh
              ? state.treeLoadedByKey
              : { ...state.treeLoadedByKey, [key]: false },
            treeErrorsByConnection: {
              ...state.treeErrorsByConnection,
              [connId]: (error as Error).message,
            },
            treeLoading: hasLoadingTreeRequests(loadingByKey),
          }
        })
      } finally {
        if (!refresh) {
          treeRequests.delete(key)
        }
      }
    })()

    // Only non-refresh loads are registered for de-duplication; a refresh is
    // always a real request and must not be joined by a later caller.
    if (!refresh) {
      treeRequests.set(key, request)
    }
    return request
  },

  setSelectedNode: async (connId: string, node: string) => {
    set((state) => ({
      selectedNodeByConnection: {
        ...state.selectedNodeByConnection,
        [connId]: node,
      },
    }))
    await get().refreshTree(connId)
  },

  // refreshTree re-reads the root plus every currently expanded namespace of one
  // connection, stale-while-revalidate: the existing tree stays visible for the
  // whole request and is replaced per key only when a newer response lands. It
  // used to delete every cached page up front, which blanked the sidebar on each
  // refresh and lost the rows entirely if the request then failed.
  refreshTree: async (connId: string) => {
    const expandedNamespaces = Array.from(get().expandedSchemas)
      .filter((key) => parseTreeKey(key).connId === connId)
      .map((key) => parseTreeKey(key).path)
      .filter((path) => path !== '')

    const generation = (treeRefreshSeq.get(connId) ?? 0) + 1
    treeRefreshSeq.set(connId, generation)
    const isNewestRefresh = () => treeRefreshSeq.get(connId) === generation

    set((state) => ({
      treeRefreshingByConnection: { ...state.treeRefreshingByConnection, [connId]: true },
    }))

    try {
      await Promise.all([
        get().fetchTree(connId, '', { refresh: true }),
        ...expandedNamespaces.map((namespace) => get().fetchTree(connId, namespace, { refresh: true })),
      ])

      if (!isNewestRefresh()) {
        return
      }

      // Prune only on a successful root read: without a trustworthy new root there
      // is no basis for deciding which cached namespace disappeared.
      const rootKey = buildTreeKey(connId, '')
      if (get().treeErrorByKey[rootKey]) {
        return
      }

      const liveNamespaces = new Set((get().treeItems[rootKey] ?? []).map((item) => item.name))
      set((state) => {
        const nextTreeItems = { ...state.treeItems }
        const nextTreeCursors = { ...state.treeCursors }
        const nextLoadedByKey = { ...state.treeLoadedByKey }
        const nextErrorByKey = { ...state.treeErrorByKey }
        const nextExpanded = new Set(state.expandedSchemas)

        Object.keys(state.treeItems).forEach((key) => {
          const parsed = parseTreeKey(key)
          if (parsed.connId !== connId || parsed.path === '' || liveNamespaces.has(parsed.path)) {
            return
          }
          delete nextTreeItems[key]
          delete nextTreeCursors[key]
          delete nextLoadedByKey[key]
          delete nextErrorByKey[key]
          nextExpanded.delete(key)
        })

        return {
          treeItems: nextTreeItems,
          treeCursors: nextTreeCursors,
          treeLoadedByKey: nextLoadedByKey,
          treeErrorByKey: nextErrorByKey,
          expandedSchemas: nextExpanded,
        }
      })
    } finally {
      // A superseded refresh must not clear the indicator the newer one owns.
      if (isNewestRefresh()) {
        set((state) => ({
          treeRefreshingByConnection: { ...state.treeRefreshingByConnection, [connId]: false },
        }))
      }
    }
  },

  toggleSchema: (connId: string, schema: string) => {
    set((state) => {
      const next = new Set(state.expandedSchemas)
      const key = buildTreeKey(connId, schema)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return { expandedSchemas: next }
    })
  },

  setTreeVisibility: (key: TreeVisibilityKey, visible: boolean) => {
    set((state) => ({
      treeVisibility: {
        ...state.treeVisibility,
        [key]: visible,
      },
    }))
  },

  hydrateVisibleSchemas: (connId: string, visibleSchemas: string[] | null | undefined) => {
    set((state) => {
      const nextVisible = visibleSchemas ?? null
      const currentVisible = state.visibleSchemasByConnection[connId]
      const isSame =
        currentVisible === nextVisible ||
        (Array.isArray(currentVisible) &&
          Array.isArray(nextVisible) &&
          currentVisible.length === nextVisible.length &&
          currentVisible.every((schema, index) => schema === nextVisible[index]))
      if (isSame) {
        return state
      }
      return {
        visibleSchemasByConnection: {
          ...state.visibleSchemasByConnection,
          [connId]: nextVisible,
        },
      }
    })
  },

  setVisibleSchemas: (connId: string, visibleSchemas: string[] | null) => {
    set((state) => ({
      visibleSchemasByConnection: {
        ...state.visibleSchemasByConnection,
        [connId]: visibleSchemas,
      },
    }))
  },

  openTab: (
    connId: string,
    object: string,
    objectType: ObjectType = 'table',
    options?: { ttlSeconds?: number | null; anchorConnId?: string }
  ) => {
    const id = buildObjectTabID(connId, object, objectType)
    const { tabs } = get()
    const existing = tabs.find((t) => t.id === id)
    if (existing) {
      set({ activeTabId: id })
      return
    }
    const anchorConnId = options?.anchorConnId !== connId ? options?.anchorConnId : undefined
    let label = object
    if (anchorConnId) {
      const database = useConnectionStore.getState().connections.find((conn) => conn.id === connId)?.database
      if (database) {
        label = `${object} · ${database}`
      }
    }
    const tab: ObjectTab = {
      kind: 'object',
      id,
      connId,
      anchorConnId,
      object,
      label,
      objectType,
      ttlSeconds: options?.ttlSeconds ?? null,
      navigationTrail: [{ tabId: id, label }],
    }
    set({ tabs: [...tabs, tab], activeTabId: id })
  },

  setTreeConn: (pageConnId: string, viewConnId: string) => {
    set((state) => {
      const next = { ...state.treeConnByPage }
      if (viewConnId === pageConnId) {
        delete next[pageConnId]
      } else {
        next[pageConnId] = viewConnId
      }
      return { treeConnByPage: next }
    })
  },

  rebindSqlTab: (tabId: string, connId: string) => {
    set((state) => ({
      tabs: state.tabs.map((tab) => {
        if (tab.id !== tabId || tab.kind !== 'sql') {
          return tab
        }
        const page = tabPageId(tab)
        return {
          ...tab,
          connId,
          anchorConnId: connId === page ? undefined : page,
        }
      }),
    }))
  },

  openTabWithFilter: (connId: string, object: string, filter: FilterExpr, objectType: ObjectType = 'table') => {
    const filters = normalizeFilters([filter])
    const { tabs, activeTabId, navigationHistory } = get()
    const dataTabs = useDataStore.getState().tabs
    const activeObjectTab = tabs.find(
      (tab): tab is ObjectTab => tab.kind === 'object' && tab.id === activeTabId
    )

    const existing = tabs.find((tab) => {
      if (tab.kind !== 'object' || tab.connId !== connId || tab.object !== object || tab.objectType !== objectType) {
        return false
      }
      const activeFilters = dataTabs[tab.id]?.opts.filters ?? tab.initialFilters ?? []
      return filtersEqual(activeFilters, filters)
    })

    if (existing) {
      set((state) => ({
        activeTabId: existing.id,
        navigationHistory: activeObjectTab
          ? [...state.navigationHistory, {
              fromTabId: activeObjectTab.id,
              toTabId: existing.id,
              fromValue: filter.value,
              fromColumn: filter.column,
              timestamp: Date.now(),
            }].slice(-10)
          : state.navigationHistory,
      }))
      return
    }

    const id = buildFilteredTabID(connId, object, objectType, filters)
    const baseTrail = activeObjectTab?.navigationTrail?.length
      ? activeObjectTab.navigationTrail
      : activeObjectTab
        ? [{ tabId: activeObjectTab.id, label: activeObjectTab.object }]
        : []
    const tab: ObjectTab = {
      kind: 'object',
      id,
      connId,
      object,
      label: `${object} (filtered)`,
      objectType,
      initialFilters: filters,
      navigationTrail: [...baseTrail, { tabId: id, label: object, filterLabel: buildFilterLabel(filters) }].slice(-10),
    }

    useDataStore.getState().setOpts(id, {
      filters,
      offset: 0,
      order_by: '',
      order_dir: 'asc',
    })

    set({
      tabs: [...tabs, tab],
      activeTabId: id,
      navigationHistory: activeObjectTab
        ? [...navigationHistory, {
            fromTabId: activeObjectTab.id,
            toTabId: id,
            fromValue: filter.value,
            fromColumn: filter.column,
            timestamp: Date.now(),
          }].slice(-10)
        : navigationHistory,
    })
  },

  clearObjectTabFilterState: (tabId: string) => {
    set((state) => ({
      tabs: state.tabs.map((tab) => {
        if (tab.kind !== 'object' || tab.id !== tabId) {
          return tab
        }
        return {
          ...tab,
          label: tab.object,
          initialFilters: [],
          navigationTrail: [{ tabId: tab.id, label: tab.object }],
        }
      }),
    }))
  },

  goBackFromTab: (tabId: string) => {
    const { tabs } = get()
    const current = tabs.find((tab): tab is ObjectTab => tab.kind === 'object' && tab.id === tabId)
    if (!current || !current.navigationTrail || current.navigationTrail.length < 2) {
      return
    }

    const previous = current.navigationTrail[current.navigationTrail.length - 2]
    set((state) => ({
      activeTabId: previous.tabId,
      tabs: state.tabs.filter((tab) => tab.id !== tabId),
      navigationHistory: state.navigationHistory.filter((entry) => entry.toTabId !== tabId),
    }))
  },

  openSqlTab: (connId: string) => {
    const { tabs } = get()
    const existingIds = new Set(tabs.map((tab) => tab.id))
    let sequence = 1
    let id = `${connId}:sql:${sequence}`
    while (existingIds.has(id)) {
      sequence += 1
      id = `${connId}:sql:${sequence}`
    }

    const tab: SqlTab = {
      kind: 'sql',
      id,
      connId,
      label: sequence === 1 ? 'SQL Console' : `SQL Console ${sequence}`,
    }
    set({ tabs: [...tabs, tab], activeTabId: id })
  },

  openRedisCliTab: (connId: string) => {
    const { tabs } = get()
    const existingIDs = new Set(tabs.map((tab) => tab.id))
    let sequence = 1
    let id = `${connId}:redis-cli:${sequence}`
    while (existingIDs.has(id)) {
      sequence += 1
      id = `${connId}:redis-cli:${sequence}`
    }

    const tab: RedisCliTab = {
      kind: 'redis-cli',
      id,
      connId,
      label: sequence === 1 ? 'Redis CLI' : `Redis CLI ${sequence}`,
    }
    set({ tabs: [...tabs, tab], activeTabId: id })
  },

  closeTab: (tabId: string) => {
    const { tabs, activeTabId } = get()
    const idx = tabs.findIndex((t) => t.id === tabId)
    if (idx === -1) return
    const nextTabs = tabs
      .filter((t) => t.id !== tabId)
      .map((tab) => {
        if (tab.kind !== 'object' || !tab.navigationTrail?.some((item) => item.tabId === tabId)) {
          return tab
        }
        const cutIndex = tab.navigationTrail.findIndex((item) => item.tabId === tabId)
        const nextTrail = tab.navigationTrail.slice(cutIndex + 1)
        return {
          ...tab,
          navigationTrail: nextTrail.length > 0 ? nextTrail : [{ tabId: tab.id, label: tab.object }],
        }
      })
    let nextActive = activeTabId
    if (activeTabId === tabId) {
      if (nextTabs.length === 0) {
        nextActive = null
      } else if (idx < nextTabs.length) {
        nextActive = nextTabs[idx].id
      } else {
        nextActive = nextTabs[nextTabs.length - 1].id
      }
    }
    set((state) => ({
      tabs: nextTabs,
      activeTabId: nextActive,
      navigationHistory: state.navigationHistory.filter((entry) => entry.fromTabId !== tabId && entry.toTabId !== tabId),
    }))
  },

  setActiveTab: (tabId: string) => {
    set({ activeTabId: tabId })
  },

  openConnection: (connId: string) => {
    set((state) =>
      state.openConnectionIds.includes(connId)
        ? state
        : { openConnectionIds: [...state.openConnectionIds, connId] }
    )
  },

  closeConnection: (connId: string) => {
    set((state) => {
      const remainingTabs = state.tabs.filter((tab) => tabPageId(tab) !== connId)
      const activeStillOpen = remainingTabs.some((tab) => tab.id === state.activeTabId)
      const nextActiveByConnection = { ...state.activeTabByConnection }
      delete nextActiveByConnection[connId]
      return {
        openConnectionIds: state.openConnectionIds.filter((id) => id !== connId),
        tabs: remainingTabs,
        activeTabByConnection: nextActiveByConnection,
        activeTabId: activeStillOpen ? state.activeTabId : null,
        navigationHistory: state.navigationHistory.filter(
          (entry) =>
            !state.tabs.some(
              (tab) => tab.connId === connId && (tab.id === entry.fromTabId || tab.id === entry.toTabId)
            )
        ),
      }
    })
  },

  // purgeConnection forgets everything about a connection that no longer exists.
  // It is distinct from closeConnection, which merely closes a page the user can
  // reopen: closeConnection matches tabPageId only, so a tab anchored on another
  // connection's page but READING from the deleted one survived it and kept
  // requesting a dead UUID, surfacing as `connection "..." not found`.
  purgeConnection: (connId: string) => {
    set((state) => purgeTabsWhere(state, (id) => id === connId))
  },

  // Bulk form of purgeConnection, run once at startup after the connection list
  // has loaded (see lib/workspacePersistence.ts): drops every restored tab whose
  // connection isn't in the live set, rather than one specific known-deleted id.
  pruneMissingConnections: (liveConnIds: string[]) => {
    const live = new Set(liveConnIds)
    set((state) => purgeTabsWhere(state, (id) => !live.has(id)))
  },
}))

// Mirror the global activeTabId into a per-connection memory so switching back to
// a connection (via a chip or a cross-source link) restores the tab that was last
// active there. Recording in one place means no activation site can be missed.
useWorkspaceStore.subscribe((state, prev) => {
  const activeId = state.activeTabId
  if (!activeId || activeId === prev.activeTabId) {
    return
  }
  const tab = state.tabs.find((item) => item.id === activeId)
  if (!tab || state.activeTabByConnection[tab.connId] === activeId) {
    return
  }
  useWorkspaceStore.setState((current) => ({
    activeTabByConnection: { ...current.activeTabByConnection, [tab.connId]: activeId },
  }))
})
