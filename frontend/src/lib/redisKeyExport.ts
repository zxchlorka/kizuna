import type { ObjectItem } from '@/types/api'

/**
 * Every id under a namespace, as a JSON list.
 *
 * The need is sample data: a few hundred device ids to drive a test or a
 * generator, which otherwise get copied out of the tree by hand.
 *
 * Reads what the tree already holds rather than asking the server again. The
 * first version re-scanned the keyspace for each export, and on a cluster of
 * several hundred million keys that meant waiting half a minute to be handed
 * five ids that were on screen the whole time: SCAN has no prefix index, so
 * finding `fp:*` means walking every key there is.
 */

/** A namespace node as the tree holds it, flattened to what the export needs. */
export interface ExportableNode {
  path: string
  keys: ObjectItem[]
  namespaces: ExportableNode[]
}

/**
 * Strips the namespace from a key name: `idfa:00584dbd-…` under `idfa` becomes
 * `00584dbd-…`. The prefix already names the file, so repeating it on every one
 * of a thousand lines is noise.
 */
export function idWithoutPrefix(key: string, namespace: string, separator: string): string {
  const prefix = `${namespace}${separator}`
  return key.startsWith(prefix) ? key.slice(prefix.length) : key
}

/**
 * Collects ids from a namespace and everything nested under it.
 *
 * Nested levels are included because the folder is what the reader pointed at:
 * exporting `user` and silently leaving out `user:session:*` would hand back a
 * list that is quietly short.
 */
export function collectNodeIds(node: ExportableNode, namespace: string, separator: string): string[] {
  const ids: string[] = []
  const walk = (current: ExportableNode) => {
    for (const item of current.keys) {
      const key = item.path ?? item.name
      if (key !== undefined) ids.push(idWithoutPrefix(key, namespace, separator))
    }
    current.namespaces.forEach(walk)
  }
  walk(node)
  return ids
}

/** The ids as the file's contents: one JSON array, one id per line. */
export function formatIdList(ids: string[]): string {
  if (ids.length === 0) return '[]\n'
  return `[\n${ids.map((id) => `  ${JSON.stringify(id)}`).join(',\n')}\n]\n`
}

/**
 * A namespace named as a file. Separators and anything a filesystem objects to
 * become dashes, so a nested namespace like `user:session` stays one legible
 * name rather than an accidental directory.
 */
export function exportFileName(namespace: string): string {
  const safe = namespace.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return `${safe === '' ? 'keys' : safe}.json`
}
