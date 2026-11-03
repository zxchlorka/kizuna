import type { Connection } from '@/types/api'

// Mirrors config.DatabaseIDSeparator: `<postgres id>~<database>` addresses another
// database on the same server with the parent's credentials. The backend resolves
// it on the fly and stores nothing, so it never shows up in the connection list
// and disappears together with its parent.
//
// The database name goes in as unpadded base64url: ids are pasted into URL paths
// unescaped everywhere, and a name like "a/b" or "q?1" would otherwise cut the
// path. base64url also has no "~", so the first separator is the only one.
const SEPARATOR = '~'

function encodeDatabase(database: string): string {
  const binary = String.fromCharCode(...new TextEncoder().encode(database))
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decodeDatabase(encoded: string): string {
  try {
    const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'))
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))
  } catch {
    return ''
  }
}

// Always hangs off the stored parent, so switching from a runtime database
// never nests one runtime id inside another.
export const databaseConnectionId = (id: string, database: string) =>
  `${parentConnectionId(id)}${SEPARATOR}${encodeDatabase(database)}`

// A stored id has no separator (they are UUIDs), so this is the id itself for one.
export const parentConnectionId = (id: string) => id.split(SEPARATOR, 1)[0]

export const isDatabaseConnectionId = (id: string) => id.includes(SEPARATOR)

// Keyed by the parent object, so a refetched parent (new host, new password)
// derives fresh entries while zustand selectors still get a stable reference
// between renders instead of a new object every time.
const derivedByParent = new WeakMap<Connection, Map<string, Connection>>()

// Looks a connection up by id, runtime database ids included.
export function findConnection(connections: Connection[], id: string | null | undefined): Connection | undefined {
  if (!id) return undefined
  const stored = connections.find((connection) => connection.id === id)
  if (stored || !isDatabaseConnectionId(id)) return stored

  const database = decodeDatabase(id.slice(id.indexOf(SEPARATOR) + 1))
  const parent = connections.find((connection) => connection.id === parentConnectionId(id))
  if (!parent || parent.type !== 'postgres' || !database) return undefined

  let derived = derivedByParent.get(parent)
  if (!derived) {
    derived = new Map()
    derivedByParent.set(parent, derived)
  }
  let connection = derived.get(id)
  if (!connection) {
    // Same shape the backend's ResolveConnection answers with.
    connection = { ...parent, id, database, name: `${parent.name} · ${database}`, visible_schemas: null }
    derived.set(id, connection)
  }
  return connection
}
