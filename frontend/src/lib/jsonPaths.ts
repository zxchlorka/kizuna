// Canonical JSON path grammar, shared between the Kafka message search field
// input, the (Task 6) field picker, and the Links feature's field extraction.
// The Go matcher in internal/connector/kafka/messages.go implements the same
// grammar and must agree with this module on the shared fixture set
// (see jsonPaths.test.ts).
//
// Canonical form:
//   src.event_data.events[].name
//   items[].attributes[].value
//   ["key.with.dot"].name
//
// Rules:
//   - a plain object key is separated by '.'
//   - an array element is denoted by '[]' (fans out across every element)
//   - a key containing '.', '[', ']', a quote or whitespace uses bracket
//     notation: ["the.key"]
//
// traverse() is strict and anchored at the root: a key descends objects only,
// '[]' descends arrays only. It never falls back to the legacy "match anywhere
// below the root" behaviour — full paths from the root are always correct, and
// the picker only ever generates full paths. The Go matcher additionally keeps
// a legacy suffix-matching affordance for hand-typed search queries, but that
// is deliberately NOT part of this canonical traversal.

// PathSegment is one step of a parsed path: either an object key or an array
// element wildcard.
export type PathSegment = { type: 'key'; key: string } | { type: 'index' }

// parsePath turns a canonical path string into an ordered list of segments.
// It tolerates a leading '$' and leading/trailing '.' so hand-typed queries
// like "$.user.id" or ".name" still parse. Legacy "[*]" is accepted as an
// alias for "[]".
export function parsePath(path: string): PathSegment[] {
  const segments: PathSegment[] = []
  const s = path.trim()
  let i = 0
  const n = s.length
  while (i < n) {
    const c = s[i]
    if (c === '.' || c === '$') {
      i++
      continue
    }
    if (c === '[') {
      // Array wildcard: [] or legacy [*].
      if (s[i + 1] === ']') {
        segments.push({ type: 'index' })
        i += 2
        continue
      }
      if (s[i + 1] === '*' && s[i + 2] === ']') {
        segments.push({ type: 'index' })
        i += 3
        continue
      }
      // Quoted key: ["..."] or ['...'].
      if (s[i + 1] === '"' || s[i + 1] === "'") {
        const quote = s[i + 1]
        let j = i + 2
        let key = ''
        while (j < n && s[j] !== quote) {
          if (s[j] === '\\' && j + 1 < n) {
            key += s[j + 1]
            j += 2
            continue
          }
          key += s[j]
          j++
        }
        j++ // consume closing quote
        if (s[j] === ']') j++ // consume closing bracket
        segments.push({ type: 'key', key })
        i = j
        continue
      }
      // Bare bracket content (e.g. [foo]) — treat as a key for leniency.
      let j = i + 1
      let key = ''
      while (j < n && s[j] !== ']') {
        key += s[j]
        j++
      }
      if (j < n) j++ // consume closing bracket
      key = key.trim()
      if (key !== '') segments.push({ type: 'key', key })
      i = j
      continue
    }
    // Plain key: everything up to the next '.' or '['.
    let j = i
    while (j < n && s[j] !== '.' && s[j] !== '[') {
      j++
    }
    const key = s.slice(i, j).trim()
    if (key !== '') segments.push({ type: 'key', key })
    i = j
  }
  return segments
}

// keyNeedsBrackets reports whether a raw object key must use bracket notation
// because a plain dot-separated form would be ambiguous.
export function keyNeedsBrackets(key: string): boolean {
  return key === '' || /[.[\]"'\s]/.test(key)
}

// formatPath renders a list of segments back into the canonical string form.
// It is the inverse of parsePath for canonical inputs and is used by the Task 6
// picker to emit a full path from a selected tree node.
export function formatPath(segments: PathSegment[]): string {
  let out = ''
  for (const seg of segments) {
    if (seg.type === 'index') {
      out += '[]'
      continue
    }
    if (keyNeedsBrackets(seg.key)) {
      out += `[${JSON.stringify(seg.key)}]`
      continue
    }
    out += out === '' ? seg.key : `.${seg.key}`
  }
  return out
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// traverse walks value following segments from the root and returns every leaf
// reached. A 'key' segment descends objects only; an 'index' segment fans out
// across array elements, so a path with '[]' can yield multiple leaves. A step
// that does not apply (missing key, key on a non-object, '[]' on a non-array)
// prunes that branch rather than throwing.
export function traverse(value: unknown, segments: PathSegment[]): unknown[] {
  let frontier: unknown[] = [value]
  for (const seg of segments) {
    const next: unknown[] = []
    for (const current of frontier) {
      if (seg.type === 'key') {
        if (isPlainObject(current) && seg.key in current) {
          next.push(current[seg.key])
        }
      } else if (Array.isArray(current)) {
        for (const el of current) next.push(el)
      }
    }
    frontier = next
    if (frontier.length === 0) break
  }
  return frontier
}

// traversePath is parsePath + traverse for a raw path string.
export function traversePath(value: unknown, path: string): unknown[] {
  return traverse(value, parsePath(path))
}

// leafEquals compares a decoded JSON scalar leaf to an entered string, mirroring
// the Go jsonLeafEquals semantics: null matches only the literal "null", numbers
// compare numerically ("123" matches 123), and objects/arrays never match.
export function leafEquals(leaf: unknown, want: string): boolean {
  if (leaf === null) return want === 'null'
  switch (typeof leaf) {
    case 'boolean':
      return String(leaf) === want
    case 'number': {
      if (want.trim() === '') return false
      const parsed = Number(want)
      return Number.isFinite(parsed) && parsed === leaf
    }
    case 'string':
      return leaf === want
    default:
      return false
  }
}

// matchField reports whether the raw JSON string has a leaf at the canonical
// path equal to want. It mirrors the Go messageMatchesField predicate for the
// shared fixture set: an empty path matches everything, invalid JSON never
// matches, and a path that resolves to no leaf never matches. (The Go matcher
// additionally accepts legacy suffix paths that start below the root; that is a
// hand-typed-query affordance and is intentionally outside this canonical
// helper — full paths from the root agree in both languages.)
export function matchField(rawValue: string, path: string, want: string): boolean {
  if (path === '') return true
  let parsed: unknown
  try {
    parsed = JSON.parse(rawValue)
  } catch {
    return false
  }
  const segments = parsePath(path)
  if (segments.length === 0) return false
  return traverse(parsed, segments).some((leaf) => leafEquals(leaf, want))
}
