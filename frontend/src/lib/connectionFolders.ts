import type { Connection, Folder } from '@/types/api'

export interface FolderNode {
  folder: Folder
  children: FolderNode[]
  connections: Connection[]
  // Connections in this folder and every folder below it.
  total: number
}

export interface FolderTree {
  children: FolderNode[]
  // Connections at top level.
  connections: Connection[]
}

// Arranged connections first by position; the rest keep config order behind
// them (sort is stable).
const byPosition = (a: Connection, b: Connection) => (a.position ?? Infinity) - (b.position ?? Infinity) || 0

// The connections of one folder in display order; '' is top level.
export function folderConnections(connections: Connection[], folderId: string): Connection[] {
  return connections.filter((c) => (c.folder_id ?? '') === folderId).sort(byPosition)
}

// The order of a folder's connections, or of a parent's subfolders, after
// dropping draggedId next to targetId.
export function arrangeAround(ordered: Array<{ id: string }>, draggedId: string, targetId: string, after: boolean): string[] {
  const ids = ordered.map((c) => c.id).filter((id) => id !== draggedId)
  const at = ids.indexOf(targetId)
  ids.splice(at < 0 ? ids.length : at + (after ? 1 : 0), 0, draggedId)
  return ids
}

// By position; equal positions (two folders lifted out of a deleted one) by name.
const folderOrder = (a: Folder, b: Folder) =>
  (a.position ?? 0) - (b.position ?? 0) ||
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
const byOrder = (a: { folder: Folder }, b: { folder: Folder }) => folderOrder(a.folder, b.folder)

// The subfolders of parentId in display order; '' is top level.
export function folderChildren(folders: Folder[], parentId: string): Folder[] {
  return folders.filter((f) => (f.parent_id ?? '') === parentId).sort(folderOrder)
}

// Builds the tree the connection list renders. A connection or folder whose
// parent is gone (a config edited by hand) lands at top level instead of
// vanishing. prune decides which branches without a single connection to drop:
// a filtered view shows where matches are, not every folder there is.
export function buildFolderTree(
  folders: Folder[],
  connections: Connection[],
  prune?: (folderId: string) => boolean
): FolderTree {
  const nodes = new Map<string, FolderNode>(
    folders.map((folder) => [folder.id, { folder, children: [], connections: [], total: 0 }])
  )
  const tree: FolderTree = { children: [], connections: [] }

  for (const node of nodes.values()) {
    const parent = node.folder.parent_id ? nodes.get(node.folder.parent_id) : undefined
    ;(parent ? parent.children : tree.children).push(node)
  }
  for (const conn of connections) {
    const folder = conn.folder_id ? nodes.get(conn.folder_id) : undefined
    ;(folder ? folder.connections : tree.connections).push(conn)
  }

  // A parent loop in a hand-edited config would leave its folders unreachable
  // from the top; the visited set also stops the walk from recursing forever.
  const visited = new Set<string>()
  const finish = (list: FolderNode[]): FolderNode[] => {
    const kept: FolderNode[] = []
    for (const node of list) {
      if (visited.has(node.folder.id)) continue
      visited.add(node.folder.id)
      node.children = finish(node.children)
      node.connections.sort(byPosition)
      node.total = node.connections.length + node.children.reduce((sum, child) => sum + child.total, 0)
      if (node.total > 0 || !prune?.(node.folder.id)) kept.push(node)
    }
    return kept.sort(byOrder)
  }
  tree.children = finish(tree.children)
  tree.connections.sort(byPosition)
  return tree
}

// Folders holding at least one connection, directly or anywhere below.
export function occupiedFolderIds(folders: Folder[], connections: Connection[]): Set<string> {
  const ids = new Set<string>()
  const walk = (nodes: FolderNode[]) =>
    nodes.forEach((node) => {
      if (node.total > 0) ids.add(node.folder.id)
      walk(node.children)
    })
  walk(buildFolderTree(folders, connections).children)
  return ids
}

// Pixels per frame to scroll the page while something is dragged near its top
// or bottom edge: negative up, positive down, 0 away from the edges. Browsers
// scroll on their own only in a strip a few pixels tall.
export function edgeScrollSpeed(y: number, viewportHeight: number, edge = 96, max = 22): number {
  if (y < edge) return -Math.ceil(((edge - Math.max(y, 0)) / edge) * max)
  if (y > viewportHeight - edge) return Math.ceil(((y - (viewportHeight - edge)) / edge) * max)
  return 0
}

// Folder names from the top down to folderId: ["Team", "Project"].
export function folderPath(folders: Folder[], folderId: string | undefined): string[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const path: string[] = []
  for (let id = folderId; id && path.length <= folders.length; id = byId.get(id)?.parent_id) {
    const folder = byId.get(id)
    if (!folder) break
    path.unshift(folder.name)
  }
  return path
}

// True when folderId is ancestorId itself or sits anywhere below it: the folders
// a folder cannot be moved into.
export function isWithinFolder(folders: Folder[], folderId: string, ancestorId: string): boolean {
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  for (let id: string | undefined = folderId, hops = 0; id && hops <= folders.length; id = byId.get(id)?.parent_id, hops++) {
    if (id === ancestorId) return true
  }
  return false
}

// Every folder in tree order with its depth, for flat pickers like "Move to".
export function flattenFolders(folders: Folder[]): Array<{ folder: Folder; depth: number }> {
  const out: Array<{ folder: Folder; depth: number }> = []
  const walk = (nodes: FolderNode[], depth: number) => {
    for (const node of nodes) {
      out.push({ folder: node.folder, depth })
      walk(node.children, depth + 1)
    }
  }
  walk(buildFolderTree(folders, []).children, 0)
  return out
}
