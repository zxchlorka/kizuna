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
  label: string
}

export interface RedisCliTab {
  kind: 'redis-cli'
  id: string
  connId: string
  label: string
}

export type WorkspaceTab = ObjectTab | SqlTab | RedisCliTab

export interface TreeVisibility {
  showTables: boolean
  showViews: boolean
  showIndexes: boolean
}

export type TreeVisibilityKey = keyof TreeVisibility

interface WorkspaceStore {
  tabs: WorkspaceTab[]
  activeTabId: string | null
  navigationHistory: NavigationEntry[]
  treeItems: Record<string, ObjectItem[]>
  treeCursors: Record<string, string>
  treeLoading: boolean
  treeLoadingByKey: Record<string, boolean>
  treeErrorByKey: Record<string, string | null>
  treeLoadedByKey: Record<string, boolean>
  treeErrorsByConnection: Record<string, string | null>
  expandedSchemas: Set<string>
  treeVisibility: TreeVisibility
  visibleSchemasByConnection: Record<string, string[] | null>
  availableSchemasByConnection: Record<string, string[]>
  selectedNodeByConnection: Record<string, string>

  fetchTree: (connId: string, path?: string) => Promise<void>
  setSelectedNode: (connId: string, node: string) => Promise<void>
  refreshTree: (connId: string) => Promise<void>
  toggleSchema: (connId: string, schema: string) => void
  setTreeVisibility: (key: TreeVisibilityKey, visible: boolean) => void
  hydrateVisibleSchemas: (connId: string, visibleSchemas: string[] | null | undefined) => void
  setVisibleSchemas: (connId: string, visibleSchemas: string[] | null) => void
  openTab: (connId: string, object: string, objectType?: ObjectType, options?: { ttlSeconds?: number | null }) => void
  openTabWithFilter: (connId: string, object: string, filter: FilterExpr, objectType?: ObjectType) => void
  clearObjectTabFilterState: (tabId: string) => void
  goBackFromTab: (tabId: string) => void
  openSqlTab: (connId: string) => void
  openRedisCliTab: (connId: string) => void
  closeTab: (tabId: string) => void
  setActiveTab: (tabId: string) => void
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

function hasLoadingTreeRequests(loadingByKey: Record<string, boolean>): boolean {
  return Object.values(loadingByKey).some(Boolean)
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  tabs: [],
  activeTabId: null,
  navigationHistory: [],
  treeItems: {},
  treeCursors: {},
  treeLoading: false,
  treeLoadingByKey: {},
  treeErrorByKey: {},
  treeLoadedByKey: {},
  treeErrorsByConnection: {},
  expandedSchemas: new Set(),
  treeVisibility: {
    showTables: true,
    showViews: false,
    showIndexes: false,
  },
  visibleSchemasByConnection: {},
  availableSchemasByConnection: {},
  selectedNodeByConnection: {},

  fetchTree: async (connId: string, path?: string) => {
    const normalizedPath = path || ''
    const key = buildTreeKey(connId, normalizedPath)
    const pending = treeRequests.get(key)
    if (pending) {
      return pending
    }

    const request = (async () => {
      set((state) => {
        const loadingByKey = { ...state.treeLoadingByKey, [key]: true }
        return {
          treeLoadingByKey: loadingByKey,
          treeErrorByKey: { ...state.treeErrorByKey, [key]: null },
          treeLoading: hasLoadingTreeRequests(loadingByKey),
        }
      })

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
        set((state) => {
          const loadingByKey = { ...state.treeLoadingByKey, [key]: false }
          return {
            treeLoadingByKey: loadingByKey,
            treeErrorByKey: { ...state.treeErrorByKey, [key]: (error as Error).message },
            treeLoadedByKey: { ...state.treeLoadedByKey, [key]: false },
            treeErrorsByConnection: {
              ...state.treeErrorsByConnection,
              [connId]: (error as Error).message,
            },
            treeLoading: hasLoadingTreeRequests(loadingByKey),
          }
        })
      } finally {
        treeRequests.delete(key)
      }
    })()

    treeRequests.set(key, request)
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

  refreshTree: async (connId: string) => {
    const expandedSchemas = Array.from(get().expandedSchemas)
      .filter((key) => parseTreeKey(key).connId === connId)
      .map((key) => parseTreeKey(key).path)

    set((state) => {
      const nextTreeItems = { ...state.treeItems }
      const nextTreeCursors = { ...state.treeCursors }
      const nextLoadingByKey = { ...state.treeLoadingByKey }
      const nextErrorByKey = { ...state.treeErrorByKey }
      const nextLoadedByKey = { ...state.treeLoadedByKey }
      Object.keys(nextTreeItems).forEach((key) => {
        if (parseTreeKey(key).connId === connId) {
          delete nextTreeItems[key]
        }
      })
      Object.keys(nextTreeCursors).forEach((key) => {
        if (parseTreeKey(key).connId === connId) {
          delete nextTreeCursors[key]
        }
      })
      Object.keys(nextLoadingByKey).forEach((key) => {
        if (parseTreeKey(key).connId === connId) {
          delete nextLoadingByKey[key]
        }
      })
      Object.keys(nextErrorByKey).forEach((key) => {
        if (parseTreeKey(key).connId === connId) {
          delete nextErrorByKey[key]
        }
      })
      Object.keys(nextLoadedByKey).forEach((key) => {
        if (parseTreeKey(key).connId === connId) {
          delete nextLoadedByKey[key]
        }
      })
      return {
        treeItems: nextTreeItems,
        treeCursors: nextTreeCursors,
        treeLoadingByKey: nextLoadingByKey,
        treeErrorByKey: nextErrorByKey,
        treeLoadedByKey: nextLoadedByKey,
        treeLoading: false,
      }
    })

    await Promise.all([get().fetchTree(connId), ...expandedSchemas.map((schema) => get().fetchTree(connId, schema))])
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

  openTab: (connId: string, object: string, objectType: ObjectType = 'table', options?: { ttlSeconds?: number | null }) => {
    const id = buildObjectTabID(connId, object, objectType)
    const { tabs } = get()
    const existing = tabs.find((t) => t.id === id)
    if (existing) {
      set({ activeTabId: id })
      return
    }
    const label = object
    const tab: ObjectTab = {
      kind: 'object',
      id,
      connId,
      object,
      label,
      objectType,
      ttlSeconds: options?.ttlSeconds ?? null,
      navigationTrail: [{ tabId: id, label: object }],
    }
    set({ tabs: [...tabs, tab], activeTabId: id })
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
}))
