import type { ObjectItem } from '@/types/api'

// One level of the Redis key tree. The whole tree is derived from a single flat
// page of keys, so a namespace is not something the server listed — it is the
// shared prefix of the keys the client already holds. That makes expanding a
// folder free, and makes its count the number of keys actually behind it rather
// than the result of a second scan with its own budget.
export interface RedisTreeNode {
  // Segment shown on the row, e.g. "profile" for the namespace or "1998…" for a
  // key sitting inside one.
  name: string
  // Full prefix this node stands for, e.g. "profile" or "a:b". Empty at the root.
  path: string
  namespaces: RedisTreeNode[]
  // Keys that end at this level, in the order the page delivered them.
  keys: ObjectItem[]
  // Keys anywhere below this node, its own included.
  keyCount: number
}

function emptyNode(name: string, path: string): RedisTreeNode {
  return { name, path, namespaces: [], keys: [], keyCount: 0 }
}

// buildRedisTree groups keys by separator, one segment per level, so
// "profile:1998:x" nests under "profile" then "1998". A key whose name ends in
// the separator ("a:b:") has a trailing empty segment; it is kept as a leaf of
// the last non-empty level rather than creating a nameless folder.
export function buildRedisTree(items: ObjectItem[], separator: string): RedisTreeNode {
  const root = emptyNode('', '')
  if (separator === '') {
    root.keys = [...items]
    root.keyCount = items.length
    return root
  }

  for (const item of items) {
    const fullKey = item.path ?? item.name
    const segments = fullKey.split(separator)
    let node = root
    node.keyCount += 1

    // The last segment is the key itself; everything before it is a namespace.
    for (let depth = 0; depth < segments.length - 1; depth += 1) {
      const segment = segments[depth]
      if (segment === '') {
        break
      }
      const path = node.path === '' ? segment : `${node.path}${separator}${segment}`
      let child = node.namespaces.find((candidate) => candidate.path === path)
      if (!child) {
        child = emptyNode(segment, path)
        node.namespaces.push(child)
      }
      child.keyCount += 1
      node = child
    }

    const leafName = node.path === '' ? fullKey : fullKey.slice(node.path.length + separator.length)
    node.keys.push({ ...item, name: leafName === '' ? fullKey : leafName })
  }

  sortNode(root)
  return root
}

function sortNode(node: RedisTreeNode) {
  node.namespaces.sort((a, b) => a.name.localeCompare(b.name))
  node.keys.sort((a, b) => a.name.localeCompare(b.name))
  node.namespaces.forEach(sortNode)
}
