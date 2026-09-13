import type { RedisObjectType } from '@/types/api'
import type { TableRow } from '@/types/api'

/**
 * What changed in a key between two reads of it.
 *
 * The point is the live test: you poke the service, hit Refresh, and want to
 * see that a gaid landed without re-reading fifteen fields. So this compares
 * the rows just loaded against the ones that were on screen a moment ago —
 * nothing is stored, no history is kept, and the baseline dies with the tab.
 */

export interface RedisDeltaEntry {
  /** The row's own handle: a hash field, a zset member, a list index. */
  id: string
  /** Absent for a removed entry, and for a set member, which has no value. */
  value?: string
  /** Absent unless the entry changed. */
  previous?: string
}

export interface RedisDelta {
  added: RedisDeltaEntry[]
  changed: RedisDeltaEntry[]
  removed: RedisDeltaEntry[]
}

export const emptyDelta: RedisDelta = { added: [], changed: [], removed: [] }

export function isEmptyDelta(delta: RedisDelta): boolean {
  return delta.added.length === 0 && delta.changed.length === 0 && delta.removed.length === 0
}

function text(value: unknown): string {
  if (value === null || value === undefined) return ''
  return typeof value === 'string' ? value : String(value)
}

/**
 * How a row is identified, and what counts as its value — both differ by type.
 *
 * A set member has no value of its own, so it can only appear or disappear;
 * comparing it to itself would report a change that cannot happen. A zset
 * member keeps its name and moves its score, which is the opposite.
 */
function identify(type: RedisObjectType, row: TableRow): { id: string; value?: string } | null {
  switch (type) {
    case 'redis_hash':
      return { id: text(row.field), value: text(row.value) }
    case 'redis_zset':
      return { id: text(row.member), value: text(row.score) }
    case 'redis_set':
      return { id: text(row.member) }
    case 'redis_list':
      return { id: text(row.index), value: text(row.value) }
    case 'redis_json':
      return { id: text(row.path), value: text(row.value) }
    case 'redis_stream':
      // An entry is immutable once written, so only arrivals are possible.
      return { id: text(row.id) }
    case 'redis_string':
      return { id: 'value', value: text(row.value) }
    default:
      return null
  }
}

/**
 * The difference between two reads, as entries a person can read.
 *
 * Deliberately dumb about order: a list that had an element prepended reports
 * every index as changed, because by index that is what happened. Reporting it
 * as "one insert" would need a sequence alignment, and being wrong about which
 * element moved is worse than being blunt about all of them.
 */
export function describeDelta(
  type: RedisObjectType,
  before: TableRow[],
  after: TableRow[],
  /**
   * Whether these rows are the whole key or a window onto it.
   *
   * This is the difference between "the field is gone" and "the field scrolled
   * out of the page", and the two are indistinguishable from the rows alone. A
   * stream is read as the last N entries, so every arrival pushes an older one
   * out of view; without this the feature reported three deletions for every
   * three appends, naming entries that are still in the stream.
   */
  complete = true
): RedisDelta {
  const previous = new Map<string, string | undefined>()
  for (const row of before) {
    const entry = identify(type, row)
    if (entry !== null) previous.set(entry.id, entry.value)
  }

  const delta: RedisDelta = { added: [], changed: [], removed: [] }
  const seen = new Set<string>()

  for (const row of after) {
    const entry = identify(type, row)
    if (entry === null) continue
    seen.add(entry.id)

    if (!previous.has(entry.id)) {
      delta.added.push({ id: entry.id, value: entry.value })
      continue
    }
    const was = previous.get(entry.id)
    if (entry.value !== undefined && was !== entry.value) {
      delta.changed.push({ id: entry.id, value: entry.value, previous: was })
    }
  }

  // Only a complete view can tell a deletion from a row that left the window.
  // ponytail: an element that moves INTO a windowed view — a zset member whose
  // score climbs into the top page — still reports as added. Telling that from
  // a real insert needs the rank it held before, which the rows do not carry.
  if (complete) {
    for (const [id] of previous) {
      if (!seen.has(id)) {
        delta.removed.push({ id })
      }
    }
  }

  return delta
}
