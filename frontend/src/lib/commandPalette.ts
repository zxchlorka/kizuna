import type { Connection, ObjectItem, ObjectType } from '@/types/api'

export interface PaletteEntry {
  // Stable React key.
  id: string
  connId: string
  connName: string
  // null opens the connection itself.
  object: string | null
  objectType: ObjectType | null
}

const SEARCHABLE: ReadonlySet<string> = new Set(['table', 'view', 'kafka_topic'])

export const redisSeparator = (c: Connection) => c.separator || c.redis_config?.separator || ':'

// First segment of every key that has one: "nms:42:a" → "nms". Keys without a
// separator have no namespace to remember.
export function topNamespaces(items: ObjectItem[], separator: string): string[] {
  const found = new Set<string>()
  for (const item of items) {
    const at = item.name.indexOf(separator)
    if (at > 0) found.add(item.name.slice(0, at))
  }
  return [...found]
}

// ponytail: namespaces only accumulate, so one deleted from Redis lingers in the
// palette; prune on a full unfiltered scan if that ever gets confusing.
const MAX_REMEMBERED_NAMESPACES = 300

export function mergeNamespaces(known: string[] = [], seen: string[]): string[] {
  const merged = [...new Set([...known, ...seen])].sort()
  return merged.length > MAX_REMEMBERED_NAMESPACES ? merged.slice(0, MAX_REMEMBERED_NAMESPACES) : merged
}

// Only what the browser already holds: every connection by name, the tables,
// views and topics of trees that were opened, and Redis namespaces remembered
// from trees opened before. Nothing is fetched to fill the palette, so opening
// it never touches a server — production included. A Redis keyspace in
// particular cannot be searched by prefix without SCANning all of it.
export function buildPaletteEntries(
  connections: Connection[],
  treeItems: Record<string, ObjectItem[]>,
  redisNamespaces: Record<string, string[]> = {}
): PaletteEntry[] {
  const names = new Map(connections.map((c) => [c.id, c.name]))
  const entries: PaletteEntry[] = connections.map((c) => ({
    id: c.id,
    connId: c.id,
    connName: c.name,
    object: null,
    objectType: null,
  }))

  const seen = new Set<string>()
  for (const [treeKey, items] of Object.entries(treeItems)) {
    const connId = treeKey.split('::', 1)[0]
    const connName = names.get(connId)
    if (!connName) continue
    for (const item of items) {
      if (!SEARCHABLE.has(item.type)) continue
      const object = item.type === 'kafka_topic' ? (item.path ?? item.name) : `${item.schema}.${item.name}`
      const id = `${connId}::${object}`
      if (seen.has(id)) continue
      seen.add(id)
      entries.push({ id, connId, connName, object, objectType: item.type as ObjectType })
    }
  }
  for (const conn of connections) {
    if (conn.type !== 'redis') continue
    for (const namespace of redisNamespaces[conn.id] ?? []) {
      const object = `${namespace}${redisSeparator(conn)}*`
      entries.push({ id: `${conn.id}::${object}`, connId: conn.id, connName: conn.name, object, objectType: 'namespace' })
    }
  }
  return entries
}

// Lower is better; null drops the entry. Every whitespace-separated word must
// match somewhere, so "stage orders" narrows to orders on the stage connection.
function score(entry: PaletteEntry, words: string[]): number | null {
  const object = (entry.object ?? '').toLowerCase()
  const bare = object.slice(object.lastIndexOf('.') + 1)
  const conn = entry.connName.toLowerCase()
  let total = 0
  for (const word of words) {
    if (bare.startsWith(word)) total += 0
    else if (object.includes(word)) total += 1
    else if (conn.startsWith(word)) total += 2
    else if (conn.includes(word)) total += 3
    else return null
  }
  return total
}

export function searchPalette(entries: PaletteEntry[], query: string, limit = 50): PaletteEntry[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return entries.filter((e) => e.object === null).slice(0, limit)

  return entries
    .map((entry) => ({ entry, rank: score(entry, words) }))
    .filter((r): r is { entry: PaletteEntry; rank: number } => r.rank !== null)
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        (a.entry.object ?? '').length - (b.entry.object ?? '').length ||
        a.entry.connName.localeCompare(b.entry.connName)
    )
    .slice(0, limit)
    .map((r) => r.entry)
}
