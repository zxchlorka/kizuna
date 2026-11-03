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

// The folder's order after dropping draggedId next to targetId.
export function arrangeAround(ordered: Connection[], draggedId: string, targetId: string, after: boolean): string[] {
  const ids = ordered.map((c) => c.id).filter((id) => id !== draggedId)
  const at = ids.indexOf(targetId)
  ids.splice(at < 0 ? ids.length : at + (after ? 1 : 0), 0, draggedId)
  return ids
}

const byName = (a: { folder: Folder }, b: { folder: Folder }) =>
  a.folder.name.localeCompare(b.folder.name, undefined, { numeric: true, sensitivity: 'base' })

// Builds the tree the connection list renders. A connection or folder whose
// parent is gone (a config edited by hand) lands at top level instead of
// vanishing. With pruneEmpty, branches without a single connection are dropped:
// a search or tag filter shows where matches are, not every folder there is.
export function buildFolderTree(folders: Folder[], connections: Connection[], pruneEmpty = false): FolderTree {
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
      if (!pruneEmpty || node.total > 0) kept.push(node)
    }
    return kept.sort(byName)
  }
  tree.children = finish(tree.children)
  tree.connections.sort(byPosition)
  return tree
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
