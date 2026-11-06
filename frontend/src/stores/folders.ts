import { create } from 'zustand'
import { fetchWithTimeout, throwOnApiError } from '@/lib/http'
import { useConnectionStore } from '@/stores/connections'
import type { Folder } from '@/types/api'

interface FoldersStore {
  folders: Folder[]
  loaded: boolean
  fetch: () => Promise<void>
  create: (name: string, parentId: string) => Promise<Folder>
  // Rename and move are one call: the backend takes both fields every time.
  update: (id: string, name: string, parentId: string) => Promise<Folder>
  remove: (id: string) => Promise<void>
  // ids is parentId's whole new order, a folder moved in from elsewhere included.
  arrange: (parentId: string, ids: string[]) => Promise<void>
}

export const useFoldersStore = create<FoldersStore>((set, get) => ({
  folders: [],
  loaded: false,

  fetch: async () => {
    const res = await fetchWithTimeout('/api/folders')
    await throwOnApiError(res)
    set({ folders: ((await res.json()) as Folder[]) ?? [], loaded: true })
  },

  create: async (name: string, parentId: string) => {
    const res = await fetchWithTimeout('/api/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, parent_id: parentId }),
    })
    await throwOnApiError(res)
    const folder = (await res.json()) as Folder
    set({ folders: [...get().folders, folder] })
    return folder
  },

  update: async (id: string, name: string, parentId: string) => {
    const res = await fetchWithTimeout(`/api/folders/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, parent_id: parentId }),
    })
    await throwOnApiError(res)
    const folder = (await res.json()) as Folder
    set({ folders: get().folders.map((f) => (f.id === id ? folder : f)) })
    return folder
  },

  arrange: async (parentId: string, ids: string[]) => {
    const res = await fetchWithTimeout('/api/folders/arrange', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent_id: parentId, folder_ids: ids }),
    })
    await throwOnApiError(res)
    const position = new Map(ids.map((id, i) => [id, i + 1]))
    set({
      folders: get().folders.map((f) =>
        position.has(f.id) ? { ...f, parent_id: parentId || undefined, position: position.get(f.id) } : f
      ),
    })
  },

  // Deleting a folder never deletes what it holds: subfolders and connections
  // move up into its parent, here exactly as on the backend.
  remove: async (id: string) => {
    const res = await fetchWithTimeout(`/api/folders/${id}`, { method: 'DELETE' })
    await throwOnApiError(res)
    const parentId = get().folders.find((f) => f.id === id)?.parent_id ?? ''
    set({
      folders: get()
        .folders.filter((f) => f.id !== id)
        .map((f) => (f.parent_id === id ? { ...f, parent_id: parentId || undefined } : f)),
    })
    useConnectionStore.getState().liftFolder(id, parentId)
  },
}))
