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

// descendKey applies one 'key' segment to one value, appending whatever it
// reaches to out.
//
// Own properties only: the membership test used to be `seg.key in current`,
// and `in` walks the prototype chain, so searching for a field named
// `toString`, `constructor` or `valueOf` matched EVERY JSON object even though
// no payload contains that field. The Go side resolves the same segment with a
// plain map lookup (jsonPathMatchesFrom in internal/connector/kafka/messages.go),
// which has no prototype chain at all.
//
// A key segment landing on an array is retried on each element, so "events.name"
// behaves like "events[].name". That mirrors Go's "legacy implicit array
// traversal" in the same function: without it a hand-typed `a.b` found nothing
// on `{"a":[{"b":1}]}` while the backend scan found it, and the two searches
// disagreed on the single most common Kafka payload shape.
function descendKey(current: unknown, key: string, out: unknown[]): void {
  if (Array.isArray(current)) {
    for (const el of current) descendKey(el, key, out)
    return
  }
  if (isPlainObject(current) && Object.prototype.hasOwnProperty.call(current, key)) {
    out.push(current[key])
  }
}

// traverse walks value following segments from the root and returns every leaf
// reached. A 'key' segment descends objects (and fans out across an array it
// lands on, see descendKey); an 'index' segment fans out across array elements,
// so a path with '[]' can yield multiple leaves. A step that does not apply
// (missing key, key on a scalar, '[]' on a non-array) prunes that branch rather
// than throwing.
export function traverse(value: unknown, segments: PathSegment[]): unknown[] {
  let frontier: unknown[] = [value]
  for (const seg of segments) {
    const next: unknown[] = []
    for (const current of frontier) {
      if (seg.type === 'key') {
        descendKey(current, seg.key, next)
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

// leafText renders a leaf the way leafEquals compares one, so a contains search
// reads the same values an equals search does. Mirrors jsonLeafText in
// messages.go; a composite leaf has no text form and matches nothing.
export function leafText(leaf: unknown): string {
  if (leaf === null) return 'null'
  switch (typeof leaf) {
    case 'boolean':
    case 'number':
      return String(leaf)
    case 'string':
      return leaf
    default:
      return ''
  }
}

// matchFieldContains is matchField with substring comparison — finding a trace
// id inside a longer url or message.
export function matchFieldContains(rawValue: string, path: string, want: string): boolean {
  if (path === '') return true
  let parsed: unknown
  try {
    parsed = JSON.parse(rawValue)
  } catch {
    return false
  }
  const segments = parsePath(path)
  if (segments.length === 0) return false
  return traverse(parsed, segments).some((leaf) => leafText(leaf).includes(want))
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

// pathExistsAnywhere reports whether the document contains the path at ANY
// depth: it tries the path from the root, then retries it from every nested
// object/array value. So "Metadata" finds both `[{"Metadata":…}]` and a
// Metadata nested several levels down, while the full "[].Metadata" also works.
//
// This mirrors the Go jsonPathMatchesAnywhere traversal used by the backend
// scan, so a path typed once behaves the same whether it is answered by the
// server (Search topic) or on already-loaded rows (Filter loaded).
//
// Presence is about the path resolving at all: null, an empty object and an
// empty array all count as present. matchField above stays strict and
// root-anchored — this helper is additive and does not change value search.
export function pathExistsAnywhere(value: unknown, segments: PathSegment[]): boolean {
  if (traverse(value, segments).length > 0) {
    return true
  }
  if (Array.isArray(value)) {
    return value.some((child) => pathExistsAnywhere(child, segments))
  }
  if (isPlainObject(value)) {
    return Object.values(value).some((child) => pathExistsAnywhere(child, segments))
  }
  return false
}

// fieldPresence answers "does this message have that field at all", the search
// you need when the values are unknown -- a freshly rolled-out optional field,
// for instance. Invalid JSON matches NEITHER 'exists' nor 'missing': it has no
// JSON fields at all, and returning every non-JSON record for a 'missing' query
// would bury the messages the search is about.
export function fieldPresence(rawValue: string, path: string, wantPresent: boolean): boolean {
  const trimmed = path.trim()
  if (trimmed === '') return true
  let parsed: unknown
  try {
    parsed = JSON.parse(rawValue)
  } catch {
    return false
  }
  const segments = parsePath(trimmed)
  if (segments.length === 0) return false
  return pathExistsAnywhere(parsed, segments) === wantPresent
}
