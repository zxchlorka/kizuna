import { describe, expect, it } from 'vitest'
import {
  fieldPresence,
  formatPath,
  matchField,
  parsePath,
  traversePath,
  type PathSegment,
} from '@/lib/jsonPaths'

// sharedFixtures MUST stay identical (documents/paths/wants/expectations) to
// jsonPathSharedFixtures in internal/connector/kafka/kafka_test.go. This is the
// cross-language proof that the Go matcher and the TS traversal agree on the
// canonical grammar. Only full paths from the root are used (no legacy suffix
// paths).
//
// The implicit-array cases at the end used to be excluded from this matrix: the
// TS traversal pruned a key segment that landed on an array while the Go matcher
// retried it across the elements, so a hand-typed "events.name" was found by
// Search topic and not by Filter loaded. TS now implements the same retry, which
// is what lets those rows live here.
const sharedFixtures: { name: string; doc: string; path: string; want: string; match: boolean }[] = [
  { name: 'top-level string', doc: '{"event_type":"batch","count":3,"ok":true}', path: 'event_type', want: 'batch', match: true },
  { name: 'top-level number', doc: '{"event_type":"batch","count":3,"ok":true}', path: 'count', want: '3', match: true },
  { name: 'top-level bool', doc: '{"event_type":"batch","count":3,"ok":true}', path: 'ok', want: 'true', match: true },
  { name: 'top-level number mismatch', doc: '{"event_type":"batch","count":3,"ok":true}', path: 'count', want: '4', match: false },
  { name: 'nested obj array obj scalar (Auth)', doc: '{"src":{"event_data":{"events":[{"name":"View"},{"name":"Auth"}]}}}', path: 'src.event_data.events[].name', want: 'Auth', match: true },
  { name: 'nested array first element', doc: '{"src":{"event_data":{"events":[{"name":"View"},{"name":"Auth"}]}}}', path: 'src.event_data.events[].name', want: 'View', match: true },
  { name: 'nested array no such value', doc: '{"src":{"event_data":{"events":[{"name":"View"},{"name":"Auth"}]}}}', path: 'src.event_data.events[].name', want: 'Nope', match: false },
  { name: 'nested arrays two levels', doc: '{"src":{"event_data":{"events":[{"data":{"items":[{"category":["regular","6208"]}]}},{"data":{"items":[{"category":["spool"]}]}}]}}}', path: 'src.event_data.events[].data.items[].category[]', want: '6208', match: true },
  { name: 'nested arrays other branch', doc: '{"src":{"event_data":{"events":[{"data":{"items":[{"category":["regular","6208"]}]}},{"data":{"items":[{"category":["spool"]}]}}]}}}', path: 'src.event_data.events[].data.items[].category[]', want: 'spool', match: true },
  { name: 'nested arrays miss', doc: '{"src":{"event_data":{"events":[{"data":{"items":[{"category":["regular","6208"]}]}},{"data":{"items":[{"category":["spool"]}]}}]}}}', path: 'src.event_data.events[].data.items[].category[]', want: 'nope', match: false },
  { name: 'missing field', doc: '{"src":{"event_data":{"events":[{"name":"Auth"}]}}}', path: 'src.event_data.missing', want: 'x', match: false },
  { name: 'null matches null literal', doc: '{"src":{"timezone_offset":null}}', path: 'src.timezone_offset', want: 'null', match: true },
  { name: 'null does not match zero', doc: '{"src":{"timezone_offset":null}}', path: 'src.timezone_offset', want: '0', match: false },
  { name: 'mixed types scalar branch', doc: '{"a":{"b":"X"}}', path: 'a.b', want: 'X', match: true },
  { name: 'mixed types object branch no match', doc: '{"a":{"b":{"nested":1}}}', path: 'a.b', want: 'X', match: false },
  { name: 'mixed types descend past scalar', doc: '{"a":{"b":"X"}}', path: 'a.b.c', want: 'X', match: false },
  { name: 'invalid json', doc: '{not json', path: 'a', want: 'anything', match: false },
  { name: 'key with dot bracket notation', doc: '{"key.with.dot":{"name":"Zulu"}}', path: '["key.with.dot"].name', want: 'Zulu', match: true },
  { name: 'key with dot plain path does not match', doc: '{"key.with.dot":{"name":"Zulu"}}', path: 'key.with.dot.name', want: 'Zulu', match: false },
  { name: 'key segment retried across an array', doc: '{"a":[{"b":1}]}', path: 'a.b', want: '1', match: true },
  { name: 'key segment retried across an array, no such value', doc: '{"a":[{"b":1}]}', path: 'a.b', want: '2', match: false },
  { name: 'implicit array traversal matches the explicit form', doc: '{"src":{"event_data":{"events":[{"name":"View"},{"name":"Auth"}]}}}', path: 'src.event_data.events.name', want: 'Auth', match: true },
  { name: 'inherited property is not a field', doc: '{"x":1}', path: 'toString', want: 'x', match: false },
  { name: 'inherited property is not a field, nested', doc: '{"a":{"b":1}}', path: 'a.constructor', want: 'x', match: false },
]

describe('matchField (shared cross-language fixtures)', () => {
  for (const fx of sharedFixtures) {
    it(`${fx.name}: ${fx.path} == ${fx.want} -> ${fx.match}`, () => {
      expect(matchField(fx.doc, fx.path, fx.want)).toBe(fx.match)
    })
  }

  it('empty path matches everything', () => {
    expect(matchField('{"a":1}', '', '')).toBe(true)
  })
})

describe('parsePath', () => {
  const cases: { in: string; want: PathSegment[] }[] = [
    { in: 'event_type', want: [{ type: 'key', key: 'event_type' }] },
    { in: 'user.id', want: [{ type: 'key', key: 'user' }, { type: 'key', key: 'id' }] },
    {
      in: 'src.event_data.events[].name',
      want: [
        { type: 'key', key: 'src' },
        { type: 'key', key: 'event_data' },
        { type: 'key', key: 'events' },
        { type: 'index' },
        { type: 'key', key: 'name' },
      ],
    },
    {
      in: 'items[].attributes[].value',
      want: [
        { type: 'key', key: 'items' },
        { type: 'index' },
        { type: 'key', key: 'attributes' },
        { type: 'index' },
        { type: 'key', key: 'value' },
      ],
    },
    { in: '["key.with.dot"].name', want: [{ type: 'key', key: 'key.with.dot' }, { type: 'key', key: 'name' }] },
    { in: 'events[*].name', want: [{ type: 'key', key: 'events' }, { type: 'index' }, { type: 'key', key: 'name' }] },
    { in: '$.user.id', want: [{ type: 'key', key: 'user' }, { type: 'key', key: 'id' }] },
    { in: "['a.b'].c", want: [{ type: 'key', key: 'a.b' }, { type: 'key', key: 'c' }] },
  ]
  for (const c of cases) {
    it(`parses ${c.in}`, () => {
      expect(parsePath(c.in)).toEqual(c.want)
    })
  }
})

describe('formatPath', () => {
  const roundTrips = [
    'src.event_data.events[].name',
    'items[].attributes[].value',
    '["key.with.dot"].name',
    'event_type',
  ]
  for (const p of roundTrips) {
    it(`round-trips ${p}`, () => {
      expect(formatPath(parsePath(p))).toBe(p)
    })
  }

  it('brackets keys with special characters', () => {
    expect(formatPath([{ type: 'key', key: 'a b' }, { type: 'key', key: 'c' }])).toBe('["a b"].c')
    expect(formatPath([{ type: 'key', key: 'k[0]' }])).toBe('["k[0]"]')
  })

  it('generates a full path from segments including array wildcards', () => {
    const segments: PathSegment[] = [
      { type: 'key', key: 'src' },
      { type: 'key', key: 'events' },
      { type: 'index' },
      { type: 'key', key: 'name' },
    ]
    expect(formatPath(segments)).toBe('src.events[].name')
  })
})

describe('traversePath', () => {
  it('fans out array wildcards into multiple leaves', () => {
    const doc = { src: { event_data: { events: [{ name: 'View' }, { name: 'Auth' }] } } }
    expect(traversePath(doc, 'src.event_data.events[].name')).toEqual(['View', 'Auth'])
  })

  it('returns a single null leaf for a null-valued path', () => {
    expect(traversePath({ src: { timezone_offset: null } }, 'src.timezone_offset')).toEqual([null])
  })

  it('returns no leaves for a missing path', () => {
    expect(traversePath({ a: 1 }, 'a.b.c')).toEqual([])
  })
})

describe('fieldPresence — поиск по наличию поля', () => {
  // Реальная форма сообщения: массив с одним объектом, Metadata опциональна.
  const withMeta = '[{"UserID":2000,"Metadata":{"marketing_device_id":"x"}}]'
  const noMeta = '[{"UserID":2000,"Field":"Gender"}]'
  const nullMeta = '[{"UserID":2000,"Metadata":null}]'
  const deepMeta = '[{"wrapper":{"inner":{"Metadata":{"a":1}}}}]'

  it('finds a top-level optional field by bare name', () => {
    expect(fieldPresence(withMeta, 'Metadata', true)).toBe(true)
  })

  it('does not find a field that is absent', () => {
    expect(fieldPresence(noMeta, 'Metadata', true)).toBe(false)
  })

  it('treats a null value as present', () => {
    expect(fieldPresence(nullMeta, 'Metadata', true)).toBe(true)
  })

  it('finds a field at any depth', () => {
    expect(fieldPresence(deepMeta, 'Metadata', true)).toBe(true)
  })

  it('finds a nested leaf by its own name', () => {
    expect(fieldPresence(withMeta, 'marketing_device_id', true)).toBe(true)
  })

  it('accepts a partial path', () => {
    expect(fieldPresence(withMeta, 'Metadata.marketing_device_id', true)).toBe(true)
  })

  it('accepts the explicit array path', () => {
    expect(fieldPresence(withMeta, '[].Metadata', true)).toBe(true)
  })

  it('inverts for the missing query', () => {
    expect(fieldPresence(noMeta, 'Metadata', false)).toBe(true)
    expect(fieldPresence(withMeta, 'Metadata', false)).toBe(false)
  })

  // Не-JSON не матчится ни одним оператором: у него нет JSON-полей вообще, и
  // выдавать его на 'missing' значило бы утопить выдачу в мусоре.
  it('never matches a non-JSON payload, not even for missing', () => {
    expect(fieldPresence('plain text', 'Metadata', true)).toBe(false)
    expect(fieldPresence('plain text', 'Metadata', false)).toBe(false)
  })

  it('an empty path matches everything (no filtering)', () => {
    expect(fieldPresence(noMeta, '   ', true)).toBe(true)
  })

  // `in` walks the prototype chain, so a presence search for any
  // Object.prototype member reported every JSON object as having that field —
  // and, inverted, reported that no message was missing it. The backend
  // resolves the same segment with a map lookup and has no such members.
  it('does not treat an inherited property as a field', () => {
    for (const inherited of ['toString', 'constructor', 'valueOf', 'hasOwnProperty']) {
      expect(fieldPresence('{"x":1}', inherited, true)).toBe(false)
      expect(fieldPresence('{"x":1}', inherited, false)).toBe(true)
    }
  })

  it('still finds an own property that shadows a prototype member', () => {
    expect(fieldPresence('{"toString":"mine"}', 'toString', true)).toBe(true)
  })

  // Hand-typed "a.b" over an array of objects: the shape most Kafka payloads
  // actually have. The backend scan matched it, the client-side filter did not.
  it('retries a key segment across array elements, like the backend scan', () => {
    expect(fieldPresence('{"a":[{"b":1}]}', 'a.b', true)).toBe(true)
    expect(fieldPresence('{"events":[{"name":"Auth"}]}', 'events.name', true)).toBe(true)
    expect(fieldPresence('{"events":[{"name":"Auth"}]}', 'events[].name', true)).toBe(true)
  })
})
