import { create } from 'zustand'
import type { ObjectItem } from '@/types/api'

interface Tab {
  id: string
  connId: string
  object: string
  label: string
}

interface WorkspaceStore {
  tabs: Tab[]
  activeTabId: string | null
  treeItems: Record<string, ObjectItem[]>
  treeLoading: boolean
  expandedSchemas: Set<string>

  fetchTree: (connId: string, path?: string) => Promise<void>
  toggleSchema: (schema: string) => void
  openTab: (connId: string, object: string) => void
  closeTab: (tabId: string) => void
  setActiveTab: (tabId: string) => void
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  tabs: [],
  activeTabId: null,
  treeItems: {},
  treeLoading: false,
  expandedSchemas: new Set(),

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

  openTab: (connId: string, object: string) => {
    const id = `${connId}:${object}`
    const { tabs } = get()
    const existing = tabs.find((t) => t.id === id)
    if (existing) {
      set({ activeTabId: id })
      return
    }
    const label = object
    const tab: Tab = { id, connId, object, label }
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
