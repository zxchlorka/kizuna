import { describe, expect, it } from 'vitest'
import {
  buildSchemaTree,
  findNode,
  type SampleRow,
  DEFAULT_SAMPLE_CAP,
} from '@/lib/jsonSchemaSample'

function jsonRow(value: unknown): SampleRow {
  return { format: 'json', value: JSON.stringify(value) }
}

// A row built from the docs/msg.json fixture: the exact nested shape from that
// file (events[] of objects, each with data.items[] whose elements carry a
// category[] string array and a deep tail_object.terms path, plus a null
// timezone_offset). Kept inline rather than read from disk so this browser-only
// test suite needs no Node built-ins or @types/node. The structure mirrors the
// real fixture the plan's acceptance scenarios search (src.event_data.events[].name).
const MSG_JSON_FIXTURE = {
  event_type: 'batch',
  host: 'analytics-prod-web-01.dl.wb.ru',
  src: {
    client_id: '',
    event_data: {
      events: [
        {
          data: { address: '312470', item_id: 379885638, shop_rating: 2 },
          event_num: 1470,
          event_time: '2026-07-16T19:49:58.931+05:00',
          name: 'View_Item_With_Shop_Rating',
          session_value: 17157706631802851000,
        },
        {
          data: {
            currency: 'RUB',
            goods: 92,
            items: [
              {
                brand: 'ВАЛМАКС',
                category: ['regular', '6208', '2240', 'none'],
                id: '212623452',
                name: 'катушка триммера YK-T023',
                price: '646.00',
                prices: { actual_price: 62600, cross_price: 97100 },
                tail_object: {
                  loc: 'SST',
                  terms: {
                    catalog_type: 'preset',
                    normquery: 'катушка для триммера электрического м6',
                    rs: 90,
                    search_text: 'катушка для триммера электрического м6 ',
                  },
                },
              },
            ],
            stock: 0,
          },
          event_num: 1471,
          event_time: '2026-07-16T19:49:58.934+05:00',
          name: 'view_item_in_list',
          session_value: 17157706631802851000,
        },
      ],
    },
    timezone_offset: null,
    user_id: '4945789519701234433',
  },
  timestamp: '2026-07-16T14:50:01.582716924Z',
}

describe('buildSchemaTree — docs/msg.json fixture reachability', () => {
  // Building a row from the fixture must let the picker reach
  // src.event_data.events[].name (and the deeper double-array paths) purely by
  // walking the sampled tree.
  const fixture = JSON.stringify(MSG_JSON_FIXTURE)

  it('reaches src.event_data.events[].name as a selectable string leaf', () => {
    const { root, sampleCount } = buildSchemaTree([{ format: 'json', value: fixture }])
    expect(sampleCount).toBe(1)

    const node = findNode(root, 'src.event_data.events[].name')
    expect(node).not.toBeNull()
    expect(node!.selectable).toBe(true)
    expect(node!.expandable).toBe(false)
    expect(node!.types).toContain('string')
    expect(node!.example).toBeTruthy()
    expect(node!.seenCount).toBe(1)
    expect(node!.sampleCount).toBe(1)
  })

  it('folds nested arrays into single [] nodes (events[].data.items[].name)', () => {
    const { root } = buildSchemaTree([{ format: 'json', value: fixture }])

    // events is an array -> exactly one '[]' child.
    const events = findNode(root, 'src.event_data.events')
    expect(events).not.toBeNull()
    expect(events!.children).toHaveLength(1)
    expect(events!.children[0].label).toBe('[]')
    expect(events!.children[0].path).toBe('src.event_data.events[]')

    // A leaf reachable only through two folded arrays.
    const itemName = findNode(root, 'src.event_data.events[].data.items[].name')
    expect(itemName).not.toBeNull()
    expect(itemName!.selectable).toBe(true)
    expect(itemName!.types).toContain('string')

    // category is an array of strings -> a selectable '[]' scalar leaf.
    const category = findNode(root, 'src.event_data.events[].data.items[].category[]')
    expect(category).not.toBeNull()
    expect(category!.label).toBe('[]')
    expect(category!.selectable).toBe(true)
    expect(category!.types).toContain('string')
  })

  it('reaches the deepest fixture path within the depth bound', () => {
    const { root, truncated } = buildSchemaTree([{ format: 'json', value: fixture }])
    const deep = findNode(root, 'src.event_data.events[].data.items[].tail_object.terms.search_text')
    expect(deep).not.toBeNull()
    expect(deep!.selectable).toBe(true)
    expect(truncated).toBe(false)
  })

  it('records a null-valued field as a selectable null leaf', () => {
    const { root } = buildSchemaTree([{ format: 'json', value: fixture }])
    const tz = findNode(root, 'src.timezone_offset')
    expect(tz).not.toBeNull()
    expect(tz!.types).toEqual(['null'])
    expect(tz!.selectable).toBe(true)
  })
})

describe('buildSchemaTree — format filtering', () => {
  it('parses only json-format rows and skips others', () => {
    const rows: SampleRow[] = [
      { format: 'text', value: '{"a":1}' },
      { format: 'binary', value: 'not-json' },
      jsonRow({ a: 1 }),
    ]
    const { root, sampleCount, jsonRowCount } = buildSchemaTree(rows)
    expect(sampleCount).toBe(1)
    expect(jsonRowCount).toBe(1)
    expect(findNode(root, 'a')).not.toBeNull()
  })

  it('skips json rows with invalid JSON without inflating sampleCount', () => {
    const rows: SampleRow[] = [
      { format: 'json', value: '{not json' },
      jsonRow({ a: 1 }),
    ]
    const { root, sampleCount, jsonRowCount } = buildSchemaTree(rows)
    expect(sampleCount).toBe(1) // only the one that parsed
    expect(jsonRowCount).toBe(2) // both json-format rows counted as considered
    expect(findNode(root, 'a')!.seenCount).toBe(1)
  })

  it('returns an empty tree when no json rows are present', () => {
    const { root, sampleCount } = buildSchemaTree([{ format: 'text', value: 'x' }])
    expect(sampleCount).toBe(0)
    expect(root.children).toHaveLength(0)
  })
})

describe('buildSchemaTree — shape merging across rows', () => {
  it('merges differing types for the same key into one node', () => {
    const { root } = buildSchemaTree([jsonRow({ a: 'x' }), jsonRow({ a: 5 })])
    const a = findNode(root, 'a')!
    expect(a.types).toEqual(['string', 'number']) // stable display order
    expect(a.seenCount).toBe(2)
    expect(a.sampleCount).toBe(2)
  })

  it('tracks seenCount as a per-message occurrence, sampleCount as the denominator', () => {
    const { root } = buildSchemaTree([jsonRow({ a: 1, b: 2 }), jsonRow({ a: 1 })])
    expect(findNode(root, 'a')!.seenCount).toBe(2)
    expect(findNode(root, 'a')!.sampleCount).toBe(2)
    expect(findNode(root, 'b')!.seenCount).toBe(1) // "1/2"
    expect(findNode(root, 'b')!.sampleCount).toBe(2)
  })
})

describe('buildSchemaTree — array folding', () => {
  it('folds all array indices under one [] node, counted once per message', () => {
    const { root } = buildSchemaTree([jsonRow({ items: [{ id: 1 }, { id: 2 }, { id: 3 }] })])
    const items = findNode(root, 'items')!
    expect(items.types).toEqual(['array'])
    expect(items.children).toHaveLength(1)
    expect(items.children[0].label).toBe('[]')

    const id = findNode(root, 'items[].id')!
    expect(id.path).toBe('items[].id')
    expect(id.types).toEqual(['number'])
    // Three elements in ONE message -> seenCount 1, not 3.
    expect(id.seenCount).toBe(1)
  })
})

describe('buildSchemaTree — bounds', () => {
  it('caps the sample at DEFAULT_SAMPLE_CAP json rows', () => {
    const rows: SampleRow[] = Array.from({ length: DEFAULT_SAMPLE_CAP + 50 }, () => jsonRow({ a: 1 }))
    const { sampleCount, jsonRowCount } = buildSchemaTree(rows)
    expect(jsonRowCount).toBe(DEFAULT_SAMPLE_CAP)
    expect(sampleCount).toBe(DEFAULT_SAMPLE_CAP)
  })

  it('honours a custom sampleCap', () => {
    const rows: SampleRow[] = Array.from({ length: 10 }, () => jsonRow({ a: 1 }))
    const { sampleCount } = buildSchemaTree(rows, { sampleCap: 3 })
    expect(sampleCount).toBe(3)
  })

  it('bounds recursion by depth and flags truncation', () => {
    // a.b.c.d — depth 4. With maxDepth 2 we descend a and b, then stop.
    const { root, truncated } = buildSchemaTree([jsonRow({ a: { b: { c: { d: 1 } } } })], { maxDepth: 2 })
    expect(truncated).toBe(true)
    expect(findNode(root, 'a.b')).not.toBeNull()
    expect(findNode(root, 'a.b.c')).toBeNull()
  })

  it('bounds the total node count and flags truncation', () => {
    const wide: Record<string, number> = {}
    for (let i = 0; i < 50; i += 1) wide[`k${i}`] = i
    const { root, truncated } = buildSchemaTree([jsonRow(wide)], { maxNodes: 10 })
    expect(truncated).toBe(true)
    expect(root.children.length).toBeLessThanOrEqual(10)
  })

  it('truncates long example strings', () => {
    const long = 'x'.repeat(500)
    const { root } = buildSchemaTree([jsonRow({ a: long })], { exampleMaxLength: 50 })
    const a = findNode(root, 'a')!
    expect(a.example!.length).toBeLessThanOrEqual(51) // 50 chars + ellipsis
    expect(a.example!.endsWith('…')).toBe(true)
  })
})

describe('buildSchemaTree — immutability', () => {
  it('does not mutate the source rows', () => {
    const row = Object.freeze({ format: 'json', value: JSON.stringify({ a: { b: 1 } }) }) as SampleRow
    const rows = Object.freeze([row]) as readonly SampleRow[]
    // Would throw if the sampler tried to mutate a frozen row/array.
    expect(() => buildSchemaTree(rows)).not.toThrow()
    expect(findNode(buildSchemaTree(rows).root, 'a.b')).not.toBeNull()
  })
})
