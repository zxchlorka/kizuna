import { parseJsonLossless } from '@/lib/json'
import { leafText, parsePath, traverse } from '@/lib/jsonPaths'

/**
 * A JSON field shown as its own column in the message table.
 *
 * The Value column truncates exactly where the meaning starts: twenty rows read
 * `{"api_key":"","event_type":"batch","file":"/opt/log…` and none of them say
 * which event it was. Pulling the two or three fields you actually came for out
 * into columns answers that without expanding a single message.
 */

// Enough of a list to see what is in it, short enough that the column stays a
// column. A batch of twenty events is not read name by name in a table cell.
const SHOWN_VALUES = 2

/** Rendered when the path resolves to nothing — a fact, not an absence of data. */
export const NO_VALUE = '—'

/**
 * Every column's value for one message, from a single parse.
 *
 * Parsed once per message rather than once per column: a hundred rows with
 * three columns each is three hundred parses of the same payloads otherwise,
 * and these payloads are not small.
 *
 * parseJsonLossless, never JSON.parse — a column showing a snowflake id would
 * round it to a different id, which is the whole class of bug this project
 * spent v0.8.1 removing.
 */
export function columnValues(value: string, format: string, paths: string[]): string[] {
  if (paths.length === 0) {
    return []
  }
  if (format !== 'json') {
    return paths.map(() => NO_VALUE)
  }

  let parsed: unknown
  try {
    parsed = parseJsonLossless(value)
  } catch {
    return paths.map(() => NO_VALUE)
  }

  return paths.map((path) => {
    const segments = parsePath(path)
    if (segments.length === 0) {
      return NO_VALUE
    }
    const leaves = traverse(parsed, segments).filter((leaf) => leaf !== null && typeof leaf !== 'object')
    return formatLeaves(leaves.map(leafText))
  })
}

/**
 * A path with `[]` resolves to several values on one message. The first couple
 * are named and the rest counted: the names say what kind of thing it is, the
 * count says not to trust the cell as the whole story.
 */
export function formatLeaves(values: string[]): string {
  if (values.length === 0) {
    return NO_VALUE
  }
  const head = values.slice(0, SHOWN_VALUES).join(', ')
  return values.length > SHOWN_VALUES ? `${head} +${values.length - SHOWN_VALUES}` : head
}

/**
 * The label over a column. Full paths are long and share a prefix, so the last
 * two segments carry what tells them apart — `cp.name` and `events[].name`
 * stay distinguishable where `src…name` twice over would not.
 */
export function columnLabel(path: string): string {
  const parts = path.split('.').filter((part) => part !== '')
  return parts.length <= 2 ? path : `…${parts.slice(-2).join('.')}`
}
