import { create } from 'zustand'
import type { ObjectItem, ObjectType } from '@/types/api'

interface Tab {
  id: string
  connId: string
  object: string
  label: string
  objectType: ObjectType
}

export interface TreeVisibility {
  showTables: boolean
  showViews: boolean
  showIndexes: boolean
}

export type TreeVisibilityKey = keyof TreeVisibility

interface WorkspaceStore {
  tabs: Tab[]
  activeTabId: string | null
  treeItems: Record<string, ObjectItem[]>
  treeLoading: boolean
  expandedSchemas: Set<string>
  treeVisibility: TreeVisibility

  fetchTree: (connId: string, path?: string) => Promise<void>
  refreshTree: (connId: string) => Promise<void>
  toggleSchema: (schema: string) => void
  setTreeVisibility: (key: TreeVisibilityKey, visible: boolean) => void
  openTab: (connId: string, object: string, objectType?: ObjectType) => void
  closeTab: (tabId: string) => void
  setActiveTab: (tabId: string) => void
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  tabs: [],
  activeTabId: null,
  treeItems: {},
  treeLoading: false,
  expandedSchemas: new Set(),
  treeVisibility: {
    showTables: true,
    showViews: false,
    showIndexes: false,
  },

  fetchTree: async (connId: string, path?: string) => {
    set({ treeLoading: true })
    try {
      const query = path ? `?path=${encodeURIComponent(path)}` : ''
      const res = await fetch(`/api/connections/${connId}/objects${query}`)
      if (!res.ok) throw new Error('Failed to fetch objects')
      const items: ObjectItem[] = await res.json()
      const key = path || ''
      set((state) => ({
        treeItems: { ...state.treeItems, [key]: items },
        treeLoading: false,
      }))
    } catch {
      set({ treeLoading: false })
    }
  },

  refreshTree: async (connId: string) => {
    const expandedSchemas = Array.from(get().expandedSchemas)
    set({ treeItems: {}, treeLoading: true })
    await get().fetchTree(connId)
    for (const schema of expandedSchemas) {
      await get().fetchTree(connId, schema)
    }
  },

  toggleSchema: (schema: string) => {
    set((state) => {
      const next = new Set(state.expandedSchemas)
      if (next.has(schema)) {
        next.delete(schema)
      } else {
        next.add(schema)
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

  openTab: (connId: string, object: string, objectType: ObjectType = 'table') => {
    const id = `${connId}:${object}`
    const { tabs } = get()
    const existing = tabs.find((t) => t.id === id)
    if (existing) {
      set({ activeTabId: id })
      return
    }
    const label = object
    const tab: Tab = { id, connId, object, label, objectType }
    set({ tabs: [...tabs, tab], activeTabId: id })
  },

  closeTab: (tabId: string) => {
    const { tabs, activeTabId } = get()
    const idx = tabs.findIndex((t) => t.id === tabId)
    if (idx === -1) return
    const nextTabs = tabs.filter((t) => t.id !== tabId)
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
    set({ tabs: nextTabs, activeTabId: nextActive })
  },

  setActiveTab: (tabId: string) => {
    set({ activeTabId: tabId })
  },
}))
