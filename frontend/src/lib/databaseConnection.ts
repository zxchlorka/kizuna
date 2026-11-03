import type { Connection } from '@/types/api'

// Mirrors config.DatabaseIDSeparator: `<postgres id>~<database>` addresses another
// database on the same server with the parent's credentials. The backend resolves
// it on the fly and stores nothing, so it never shows up in the connection list
// and disappears together with its parent.
const SEPARATOR = '~'

export const databaseConnectionId = (parentId: string, database: string) => `${parentId}${SEPARATOR}${database}`

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

  const database = id.slice(id.indexOf(SEPARATOR) + 1)
  const parent = connections.find((connection) => connection.id === parentConnectionId(id))
  if (!parent || parent.type !== 'postgres' || !database) return undefined

  let derived = derivedByParent.get(parent)
  if (!derived) {
    derived = new Map()
    derivedByParent.set(parent, derived)
  }
  let connection = derived.get(database)
  if (!connection) {
    // Same shape the backend's ResolveConnection answers with.
    connection = { ...parent, id, database, name: `${parent.name} · ${database}`, visible_schemas: null }
    derived.set(database, connection)
  }
  return connection
}
