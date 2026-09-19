/**
 * Comparing several Redis keys to find what they have in common.
 *
 * Not a diff — a diff answers "what changed", and these keys did not change
 * into one another. The question is "what do they share": two profiles that
 * carry the same cookie or the same install id are two profiles that should
 * probably have been one, and finding that by eye across sixteen fields and
 * four keys is how an afternoon disappears.
 */

/** Ids are stored joined: mapper.go writes strings.Join(values, ","). */
const LIST_SEPARATOR = ','

export interface CompareValue {
  text: string
  /** Present in at least one other key being compared. */
  shared: boolean
}

export interface CompareRow {
  field: string
  /** One cell per key, in the order the keys were given. Empty means absent. */
  cells: CompareValue[][]
  /** Any value on this row occurs in more than one key. */
  hasShared: boolean
  /** No key carries this field at all. */
  allEmpty: boolean
}

export interface CompareDocument {
  key: string
  type: string
  value: unknown
}

export interface CompareResult {
  rows: CompareRow[]
  /** Distinct values that occur in more than one key, most widely shared first. */
  sharedValues: Array<{ field: string; value: string; keys: string[] }>
}

/**
 * A key reduced to field → raw value, whatever its type.
 *
 * A hash has real fields. Everything else has one: a set is its members, a
 * string is its value. Collapsing them this way keeps the comparison table one
 * shape instead of six, and the row label still says what it is looking at.
 */
export function documentFields(doc: CompareDocument): Map<string, string> {
  const fields = new Map<string, string>()
  const value = doc.value

  if (doc.type === 'hash' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [field, raw] of Object.entries(value as Record<string, unknown>)) {
      fields.set(field, String(raw ?? ''))
    }
    return fields
  }

  if (Array.isArray(value)) {
    // A zset arrives as {member, score} pairs; the member is the identifier and
    // the score is when it was seen, which is not what "shared" asks about.
    const items = value.map((item) =>
      item !== null && typeof item === 'object' && 'member' in item
        ? String((item as { member: unknown }).member ?? '')
        : String(item ?? '')
    )
    fields.set('members', items.join(LIST_SEPARATOR))
    return fields
  }

  fields.set('value', value === null || value === undefined ? '' : String(value))
  return fields
}

/**
 * Splits a stored field into the values it actually holds.
 *
 * Comparing the joined strings answers the wrong question: `a,b,c` and `a,d`
 * are different strings and share the cookie `a`, which is the entire point of
 * opening this screen. Splitting a field that is not a list costs nothing — it
 * yields one value, and a whole-string match still matches.
 */
export function splitValues(raw: string): string[] {
  return raw
    .split(LIST_SEPARATOR)
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

export function compareDocuments(docs: CompareDocument[]): CompareResult {
  const perKey = docs.map(documentFields)

  // Union, in first-seen order: a field only the third key has still deserves a
  // row, and sorting alphabetically would scatter related ids apart.
  const fieldOrder: string[] = []
  for (const fields of perKey) {
    for (const field of fields.keys()) {
      if (!fieldOrder.includes(field)) fieldOrder.push(field)
    }
  }

  const rows: CompareRow[] = []
  const sharedValues: CompareResult['sharedValues'] = []

  for (const field of fieldOrder) {
    const perKeyValues = perKey.map((fields) => splitValues(fields.get(field) ?? ''))

    // Which keys carry each value. A value repeated inside one key is still
    // one key, so the owners are a set.
    const owners = new Map<string, Set<number>>()
    perKeyValues.forEach((values, index) => {
      for (const value of values) {
        const holders = owners.get(value) ?? new Set<number>()
        holders.add(index)
        owners.set(value, holders)
      }
    })

    const cells = perKeyValues.map((values) =>
      values.map((text) => ({ text, shared: (owners.get(text)?.size ?? 0) > 1 }))
    )

    for (const [value, holders] of owners) {
      if (holders.size > 1) {
        sharedValues.push({
          field,
          value,
          keys: [...holders].sort((a, b) => a - b).map((index) => docs[index].key),
        })
      }
    }

    rows.push({
      field,
      cells,
      hasShared: cells.some((cell) => cell.some((value) => value.shared)),
      allEmpty: perKeyValues.every((values) => values.length === 0),
    })
  }

  // Widest agreement first: a value in four keys out of five says more than one
  // in two, and it is what the reader came to find.
  sharedValues.sort((a, b) => b.keys.length - a.keys.length)

  return { rows, sharedValues }
}
