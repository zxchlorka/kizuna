import type { Connection } from '@/types/api'

export interface ConnectionGroup {
  // Lowercased tag; '' for connections without one.
  key: string
  // Tag as the first connection in the group spelled it.
  label: string
  connections: Connection[]
}

// Environments sort by risk, the rest alphabetically, untagged last.
const ENV_RANK: Record<string, number> = {
  production: 0,
  prod: 0,
  staging: 1,
  stage: 1,
  development: 2,
  dev: 2,
}

export function filterConnectionsByName(connections: Connection[], query: string): Connection[] {
  const needle = query.trim().toLowerCase()
  return needle ? connections.filter((c) => c.name.toLowerCase().includes(needle)) : connections
}

const tagKeys = (conn: Connection) => (conn.tags ?? []).map((t) => t.trim()).filter(Boolean)

const rank = (key: string) => (key === '' ? 99 : (ENV_RANK[key] ?? 50))
const byRank = (a: { key: string }, b: { key: string }) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key)

export interface TagOption {
  key: string
  label: string
  count: number
}

// Every distinct tag with the number of connections carrying it, in group order.
export function collectTags(connections: Connection[]): TagOption[] {
  const tags = new Map<string, TagOption>()
  for (const conn of connections) {
    for (const label of new Set(tagKeys(conn))) {
      const key = label.toLowerCase()
      const tag = tags.get(key) ?? { key, label, count: 0 }
      tag.count++
      tags.set(key, tag)
    }
  }
  return [...tags.values()].sort(byRank)
}

// Gmail-style chip click: a plain click shows only that tag (or everything again if it
// already was the only one); Cmd/Ctrl/Shift-click adds or removes it from the selection.
export function nextTagSelection(selected: ReadonlySet<string>, key: string, additive: boolean): Set<string> {
  if (!additive) return selected.size === 1 && selected.has(key) ? new Set() : new Set([key])
  const next = new Set(selected)
  if (!next.delete(key)) next.add(key)
  return next
}

// Keeps connections carrying at least one selected tag; an empty selection keeps all.
export function filterConnectionsByTags(connections: Connection[], selected: ReadonlySet<string>): Connection[] {
  if (selected.size === 0) return connections
  return connections.filter((c) => tagKeys(c).some((t) => selected.has(t.toLowerCase())))
}

// A connection with several tags lives under one of them, so every card shows up exactly once:
// the first selected tag if a tag filter is active, otherwise its first tag.
export function groupConnectionsByTag(
  connections: Connection[],
  selected: ReadonlySet<string> = new Set()
): ConnectionGroup[] {
  const groups = new Map<string, ConnectionGroup>()
  for (const conn of connections) {
    const tags = tagKeys(conn)
    const label = tags.find((t) => selected.has(t.toLowerCase())) ?? tags[0] ?? ''
    const key = label.toLowerCase()
    const group = groups.get(key) ?? { key, label, connections: [] }
    group.connections.push(conn)
    groups.set(key, group)
  }

  return [...groups.values()].sort(byRank)
}
