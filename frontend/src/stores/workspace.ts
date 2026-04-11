import { create } from 'zustand'
import { fetchWithTimeout } from '@/lib/http'
import { normalizeFilters, filtersEqual } from '@/lib/table'
import { useDataStore } from '@/stores/data'
import type { FilterExpr, ObjectItem, ObjectType } from '@/types/api'

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
  initialFilters?: FilterExpr[]
  navigationTrail?: NavigationTrailItem[]
}

export interface SqlTab {
  kind: 'sql'
  id: string
  connId: string
  label: string
}

export type WorkspaceTab = ObjectTab | SqlTab

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
  treeLoading: boolean
  treeErrorsByConnection: Record<string, string | null>
  expandedSchemas: Set<string>
  treeVisibility: TreeVisibility
  visibleSchemasByConnection: Record<string, string[] | null>
  availableSchemasByConnection: Record<string, string[]>

  fetchTree: (connId: string, path?: string) => Promise<void>
  refreshTree: (connId: string) => Promise<void>
  toggleSchema: (connId: string, schema: string) => void
  setTreeVisibility: (key: TreeVisibilityKey, visible: boolean) => void
  hydrateVisibleSchemas: (connId: string, visibleSchemas: string[] | null | undefined) => void
  setVisibleSchemas: (connId: string, visibleSchemas: string[] | null) => void
  openTab: (connId: string, object: string, objectType?: ObjectType) => void
  openTabWithFilter: (connId: string, object: string, filter: FilterExpr, objectType?: ObjectType) => void
  clearObjectTabFilterState: (tabId: string) => void
  goBackFromTab: (tabId: string) => void
  openSqlTab: (connId: string) => void
  closeTab: (tabId: string) => void
  setActiveTab: (tabId: string) => void
}

function buildFilterSignature(filters: FilterExpr[]): string {
  return JSON.stringify(normalizeFilters(filters))
}

function buildFilteredTabID(connId: string, object: string, filters: FilterExpr[]): string {
  return `${connId}:${object}:filtered:${buildFilterSignature(filters)}`
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

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  tabs: [],
  activeTabId: null,
  navigationHistory: [],
  treeItems: {},
  treeLoading: false,
  treeErrorsByConnection: {},
  expandedSchemas: new Set(),
  treeVisibility: {
    showTables: true,
    showViews: false,
    showIndexes: false,
  },
  visibleSchemasByConnection: {},
  availableSchemasByConnection: {},

  fetchTree: async (connId: string, path?: string) => {
    set({ treeLoading: true })
    try {
      const query = path ? `?path=${encodeURIComponent(path)}` : ''
      const res = await fetchWithTimeout(`/api/connections/${connId}/objects${query}`)
      if (!res.ok) throw new Error('Failed to fetch objects')
      const items: ObjectItem[] = await res.json()
      const key = buildTreeKey(connId, path || '')
      set((state) => ({
        treeItems: { ...state.treeItems, [key]: items },
        treeErrorsByConnection: {
          ...state.treeErrorsByConnection,
          [connId]: null,
        },
        availableSchemasByConnection: path
          ? state.availableSchemasByConnection
          : {
              ...state.availableSchemasByConnection,
              [connId]: items
                .filter((item) => item.type === 'schema')
                .map((item) => item.name),
            },
        treeLoading: false,
      }))
    } catch (error) {
      set((state) => ({
        treeLoading: false,
        treeErrorsByConnection: {
          ...state.treeErrorsByConnection,
          [connId]: (error as Error).message,
        },
      }))
    }
  },

  refreshTree: async (connId: string) => {
    const expandedSchemas = Array.from(get().expandedSchemas)
      .filter((key) => parseTreeKey(key).connId === connId)
      .map((key) => parseTreeKey(key).path)

    set((state) => {
      const nextTreeItems = { ...state.treeItems }
      Object.keys(nextTreeItems).forEach((key) => {
        if (parseTreeKey(key).connId === connId) {
          delete nextTreeItems[key]
        }
      })
      return { treeItems: nextTreeItems, treeLoading: true }
    })

    await get().fetchTree(connId)
    for (const schema of expandedSchemas) {
      await get().fetchTree(connId, schema)
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

  openTab: (connId: string, object: string, objectType: ObjectType = 'table') => {
    const id = `${connId}:${object}`
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
      if (tab.kind !== 'object' || tab.connId !== connId || tab.object !== object) {
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

    const id = buildFilteredTabID(connId, object, filters)
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
