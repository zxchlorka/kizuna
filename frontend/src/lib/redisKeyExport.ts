import { fetchWithTimeout, throwOnApiError } from '@/lib/http'
import type { ObjectItem } from '@/types/api'

/**
 * Every key under a namespace, as a JSON list of ids.
 *
 * The need is sample data: a thousand real device ids to drive a test, a
 * generator or a fixture, which otherwise get copied out of the tree by hand a
 * dozen at a time.
 *
 * Walks the same paged endpoint the tree uses rather than adding one of its
 * own. A page ends on the server's scan budget, not at the end of the keyspace,
 * so the loop follows the cursor until the server stops handing one back.
 */

/** The ceiling, so a mistyped prefix on a huge keyspace cannot run forever. */
export const MAX_EXPORTED_KEYS = 50_000

export interface KeyExportResult {
  /** Ids, with the namespace prefix removed — it already names the file. */
  ids: string[]
  /** Stopped at MAX_EXPORTED_KEYS rather than at the end of the namespace. */
  capped: boolean
}

interface ObjectPageResponse {
  objects?: ObjectItem[]
  next_cursor?: string
}

/**
 * Strips the namespace from a key name: `idfa:00584dbd-…` under `idfa` becomes
 * `00584dbd-…`. The prefix is what the file is named after, so repeating it on
 * every one of a thousand lines would be noise.
 */
export function idWithoutPrefix(key: string, namespace: string, separator: string): string {
  const prefix = `${namespace}${separator}`
  return key.startsWith(prefix) ? key.slice(prefix.length) : key
}

export async function collectNamespaceKeys(
  connId: string,
  namespace: string,
  separator: string,
  options: { signal?: AbortSignal; onProgress?: (count: number) => void } = {}
): Promise<KeyExportResult> {
  const match = `${namespace}${separator}*`
  const ids: string[] = []
  // A key can come back twice across pages: SCAN guarantees every key present
  // for the whole iteration is returned at least once, not at most once.
  const seen = new Set<string>()
  let cursor = ''

  for (;;) {
    const params = new URLSearchParams({ paged: '1', flat: '1', match })
    if (cursor) params.set('cursor', cursor)

    const res = await fetchWithTimeout(
      `/api/connections/${connId}/objects?${params.toString()}`,
      { signal: options.signal },
      Infinity,
      options.signal
    )
    await throwOnApiError(res)
    const page = (await res.json()) as ObjectPageResponse

    for (const item of page.objects ?? []) {
      const key = item.path ?? item.name
      if (key === undefined || seen.has(key)) continue
      seen.add(key)
      ids.push(idWithoutPrefix(key, namespace, separator))
    }
    options.onProgress?.(ids.length)

    if (ids.length >= MAX_EXPORTED_KEYS) {
      return { ids: ids.slice(0, MAX_EXPORTED_KEYS), capped: true }
    }
    cursor = page.next_cursor ?? ''
    if (cursor === '') {
      return { ids, capped: false }
    }
  }
}

/** The ids as the file's contents: one JSON array, one id per line. */
export function formatIdList(ids: string[]): string {
  if (ids.length === 0) return '[]\n'
  return `[\n${ids.map((id) => `  ${JSON.stringify(id)}`).join(',\n')}\n]\n`
}

/**
 * A namespace named as a file. Separators and anything a filesystem objects to
 * become dashes, so a nested namespace like `user:session` is still one legible
 * name rather than an accidental directory.
 */
export function exportFileName(namespace: string): string {
  const safe = namespace.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return `${safe === '' ? 'keys' : safe}.json`
}
