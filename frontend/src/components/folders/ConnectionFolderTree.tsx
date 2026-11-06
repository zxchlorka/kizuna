import { useEffect, useRef, useState, type DragEvent } from 'react'
import { CornerLeftUp } from 'lucide-react'
import { ConnectionCard } from '@/components/ConnectionCard'
import { FolderNameInput } from '@/components/folders/FolderNameInput'
import { FolderSection } from '@/components/folders/FolderSection'
import {
  arrangeAround,
  edgeScrollSpeed,
  folderChildren,
  folderConnections,
  folderPath,
  isWithinFolder,
  type FolderTree,
} from '@/lib/connectionFolders'
import { cn } from '@/lib/utils'
import { useConnectionStore } from '@/stores/connections'
import { useFoldersStore } from '@/stores/folders'
import { useToastStore } from '@/stores/toast'
import type { Connection, Folder } from '@/types/api'

const COLLAPSED_KEY = 'kizuna:connections:collapsedFolders'

function readCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

export interface DragItem {
  kind: 'connection' | 'folder'
  id: string
  // Where the item is now; '' for top level.
  folderId: string
}

// Everything a FolderSection needs from the tree, passed down unchanged
// through every level.
export interface FolderTreeControls {
  // While searching by name every folder is forced open, so no match hides in
  // a folded one; folding is off then. Type tabs and tags keep the folding.
  searching: boolean
  isOpen: (folderId: string) => boolean
  toggle: (folderId: string) => void
  overFolderId: string | null
  // The folder a dragged folder would land before or after, as its sibling.
  overEdge: { id: string; after: boolean } | null
  headerDragOver: (e: DragEvent<HTMLElement>, folder: Folder) => void
  headerDrop: (e: DragEvent, folder: Folder) => void
  dragStart: (e: DragEvent, item: DragItem) => void
  dragEnd: () => void
  dragOver: (e: DragEvent, folderId: string) => void
  drop: (e: DragEvent, folderId: string) => void
  creatingIn: string | null
  startCreating: (parentId: string | null) => void
  create: (name: string, parentId: string) => Promise<void>
  renamingId: string | null
  setRenamingId: (id: string | null) => void
  rename: (id: string, name: string) => Promise<void>
  moveFolder: (id: string, parentId: string) => Promise<void>
  removeFolder: (id: string) => Promise<void>
}

interface ConnectionFolderTreeProps {
  tree: FolderTree
  // A search by name is on: every folder opens so no match hides in a
  // collapsed one.
  searching: boolean
  // A search would prune the new, still empty folder the moment it is made.
  onClearSearch: () => void
  creatingIn: string | null
  onCreatingInChange: (parentId: string | null) => void
  onEdit: (connection: Connection) => void
  onDelete: (id: string) => Promise<void>
}

export function ConnectionFolderTree({
  tree,
  searching,
  onClearSearch,
  creatingIn,
  onCreatingInChange,
  onEdit,
  onDelete,
}: ConnectionFolderTreeProps) {
  const pushToast = useToastStore((state) => state.push)
  const folders = useFoldersStore((state) => state.folders)
  const createFolder = useFoldersStore((state) => state.create)
  const updateFolder = useFoldersStore((state) => state.update)
  const deleteFolder = useFoldersStore((state) => state.remove)
  const arrangeFolders = useFoldersStore((state) => state.arrange)
  const moveToFolder = useConnectionStore((state) => state.moveToFolder)
  const arrange = useConnectionStore((state) => state.arrange)
  // The full list, not the filtered one on screen: a new order has to place
  // the connections a filter hides too.
  const allConnections = useConnectionStore((state) => state.connections)
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [dragging, setDragging] = useState<DragItem | null>(null)
  const [overFolderId, setOverFolderId] = useState<string | null>(null)
  // The card a dragged connection would land next to, and on which side.
  const [overCard, setOverCard] = useState<{ id: string; after: boolean } | null>(null)
  const [overEdge, setOverEdge] = useState<{ id: string; after: boolean } | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const dragStartFrame = useRef(0)

  // While something is dragged near the top or bottom of the window, scroll the
  // page, so a folder off screen can be reached without dropping first.
  useEffect(() => {
    if (!dragging) return
    let y = -1
    let frame = 0
    const track = (e: globalThis.DragEvent) => {
      y = e.clientY
    }
    const step = () => {
      if (y >= 0) window.scrollBy(0, edgeScrollSpeed(y, window.innerHeight))
      frame = requestAnimationFrame(step)
    }
    // Capture: folders and cards stop the dragover from bubbling.
    document.addEventListener('dragover', track, true)
    frame = requestAnimationFrame(step)
    return () => {
      document.removeEventListener('dragover', track, true)
      cancelAnimationFrame(frame)
    }
  }, [dragging])

  const fail = (title: string) => (error: unknown) =>
    pushToast({ tone: 'error', title, message: (error as Error).message })

  const toggle = (folderId: string) => {
    const next = new Set(collapsed)
    if (!next.delete(folderId)) next.add(folderId)
    setCollapsed(next)
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]))
    } catch {
      // Private mode or blocked storage: folders still fold for this visit.
    }
  }

  const canDrop = (folderId: string) =>
    dragging !== null &&
    dragging.folderId !== folderId &&
    !(dragging.kind === 'folder' && isWithinFolder(folders, folderId, dragging.id))

  const moveFolder = async (id: string, parentId: string) => {
    const folder = folders.find((f) => f.id === id)
    if (!folder) return
    await updateFolder(id, folder.name, parentId).catch(fail('Move failed'))
  }

  const moveItem = async (item: DragItem, folderId: string) => {
    if (item.kind === 'folder') {
      await moveFolder(item.id, folderId)
      return
    }
    await moveToFolder(item.id, folderId).catch(fail('Move failed'))
  }

  const controls: FolderTreeControls = {
    searching,
    isOpen: (folderId) => searching || !collapsed.has(folderId),
    toggle,
    overFolderId,
    overEdge,
    // The top and bottom thirds of a folder's header place a dragged folder
    // before or after it; the middle, like the rest of the folder, drops it in.
    headerDragOver: (e, folder) => {
      if (dragging?.kind !== 'folder' || dragging.id === folder.id) return
      const rect = e.currentTarget.getBoundingClientRect()
      const offset = e.clientY - rect.top
      const edge = offset < rect.height / 3 ? false : offset > (rect.height * 2) / 3 ? true : null
      // Inside the dragged folder's own branch there is nowhere to put it.
      if (edge === null || isWithinFolder(folders, folder.id, dragging.id)) {
        setOverEdge(null)
        return
      }
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
      setOverFolderId(null)
      setOverEdge({ id: folder.id, after: edge })
    },
    headerDrop: (e, folder) => {
      if (dragging?.kind !== 'folder' || overEdge?.id !== folder.id) return
      e.preventDefault()
      e.stopPropagation()
      const parentId = folder.parent_id ?? ''
      const ids = arrangeAround(folderChildren(folders, parentId), dragging.id, folder.id, overEdge.after)
      controls.dragEnd()
      void arrangeFolders(parentId, ids).catch(fail('Move failed'))
    },
    dragStart: (e, item) => {
      // Firefox starts a drag only once something is set on the transfer.
      e.dataTransfer.setData('text/plain', item.id)
      e.dataTransfer.effectAllowed = 'move'
      e.stopPropagation()
      // A frame later: dragging a nested item shows the top-level drop strip
      // above the list, and a layout shift under the pointer during dragstart
      // makes Chrome cancel the drag on the spot.
      dragStartFrame.current = requestAnimationFrame(() => setDragging(item))
    },
    dragEnd: () => {
      cancelAnimationFrame(dragStartFrame.current)
      setDragging(null)
      setOverFolderId(null)
      setOverCard(null)
      setOverEdge(null)
    },
    // The innermost folder under the pointer claims the drag; stopPropagation
    // keeps the folders around it from highlighting too.
    dragOver: (e, folderId) => {
      if (!dragging) return
      e.stopPropagation()
      setOverCard(null)
      setOverEdge(null)
      if (!canDrop(folderId)) {
        setOverFolderId(null)
        return
      }
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setOverFolderId(folderId)
    },
    drop: (e, folderId) => {
      e.preventDefault()
      e.stopPropagation()
      const item = dragging
      controls.dragEnd()
      if (item && canDrop(folderId)) void moveItem(item, folderId)
    },
    creatingIn,
    startCreating: (parentId) => {
      if (parentId !== null && searching) onClearSearch()
      if (parentId && collapsed.has(parentId)) toggle(parentId)
      onCreatingInChange(parentId)
    },
    create: async (name, parentId) => {
      await createFolder(name, parentId)
        .then(() => onCreatingInChange(null))
        .catch(fail('Folder not created'))
    },
    renamingId,
    setRenamingId,
    rename: async (id, name) => {
      const folder = folders.find((f) => f.id === id)
      if (!folder) return
      await updateFolder(id, name, folder.parent_id ?? '')
        .then(() => setRenamingId(null))
        .catch(fail('Rename failed'))
    },
    moveFolder,
    removeFolder: async (id) => {
      const folder = folders.find((f) => f.id === id)
      if (!folder) return
      const destination = folderPath(folders, folder.parent_id).join(' / ') || 'top level'
      await deleteFolder(id)
        .then(() =>
          pushToast({ tone: 'success', title: `Folder ${folder.name} deleted`, message: `Its contents moved to ${destination}.` })
        )
        .catch(fail('Delete failed'))
    },
  }

  // Dropping a connection on a card places it before or after that card,
  // whichever half the pointer is over; a card in another folder moves it there.
  const cardDragOver = (e: DragEvent<HTMLDivElement>, conn: Connection) => {
    if (dragging?.kind !== 'connection' || dragging.id === conn.id) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    const rect = e.currentTarget.getBoundingClientRect()
    setOverFolderId(null)
    setOverCard({ id: conn.id, after: e.clientX > rect.left + rect.width / 2 })
  }

  const cardDrop = (e: DragEvent<HTMLDivElement>, conn: Connection) => {
    if (dragging?.kind !== 'connection' || dragging.id === conn.id) return
    e.preventDefault()
    e.stopPropagation()
    const after = overCard?.id === conn.id && overCard.after
    const folderId = conn.folder_id ?? ''
    const ids = arrangeAround(folderConnections(allConnections, folderId), dragging.id, conn.id, after)
    controls.dragEnd()
    void arrange(folderId, ids).catch(fail('Move failed'))
  }

  const renderConnections = (connections: Connection[]) => (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {connections.map((conn) => (
        <div
          key={conn.id}
          draggable
          onDragStart={(e) => controls.dragStart(e, { kind: 'connection', id: conn.id, folderId: conn.folder_id ?? '' })}
          onDragEnd={controls.dragEnd}
          onDragOver={(e) => cardDragOver(e, conn)}
          onDrop={(e) => cardDrop(e, conn)}
          className={cn('relative', dragging?.kind === 'connection' && dragging.id === conn.id && 'opacity-40')}
        >
          {overCard?.id === conn.id && (
            <div
              aria-hidden
              className={cn(
                'pointer-events-none absolute inset-y-0 z-10 w-[2px] rounded-full bg-amber-500',
                overCard.after ? '-right-[7px]' : '-left-[7px]'
              )}
            />
          )}
          <ConnectionCard connection={conn} onDelete={onDelete} onEdit={onEdit} />
        </div>
      ))}
    </div>
  )

  const showTopLevelTarget = dragging !== null && dragging.folderId !== ''

  return (
    <div
      className="space-y-3"
      onDragOver={(e) => controls.dragOver(e, '')}
      onDrop={(e) => controls.drop(e, '')}
    >
      {showTopLevelTarget && (
        <div
          className={cn(
            'flex h-9 items-center gap-2 rounded-sm border border-dashed px-3 font-mono text-xs transition-colors',
            overFolderId === ''
              ? 'border-amber-500/60 bg-amber-500/[0.06] text-amber-500'
              : 'border-border text-muted-foreground'
          )}
        >
          <CornerLeftUp className="h-3.5 w-3.5" />
          Drop here to move to top level
        </div>
      )}
      {creatingIn === '' && (
        <div className="px-1">
          <FolderNameInput onSubmit={(name) => controls.create(name, '')} onCancel={() => onCreatingInChange(null)} />
        </div>
      )}
      {tree.children.map((node) => (
        <FolderSection key={node.folder.id} node={node} controls={controls} renderConnections={renderConnections} />
      ))}
      {tree.connections.length > 0 && (
        <div className={cn(tree.children.length > 0 && 'pt-3')}>{renderConnections(tree.connections)}</div>
      )}
    </div>
  )
}
