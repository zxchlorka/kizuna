import { describe, expect, it } from 'vitest'
import { filterLoadedMessages, type KafkaMatchCondition, type KafkaMessageRow } from '@/stores/kafka'

function message(value: string): KafkaMessageRow {
  return { partition: 0, offset: 1, timestamp: '', key: '', value, format: 'json', headers: {} } as KafkaMessageRow
}

// The same fixtures the Go side asserts on (match_join_test.go). Both answer the
// same conditions — "Filter loaded" here, "Search topic" there — and rows that
// differ depending on which button was pressed would be worse than either being
// wrong alone.
const conditions: KafkaMatchCondition[] = [
  { field: 'event_type', value: 'batch', op: 'missing' },
  { field: 'src.event_data.cp.name', value: 'Carousel_All', op: 'eq', join: 'and' },
  { field: 'src.event_data.cp.name', value: 'CheckingItems', op: 'eq', join: 'or' },
]

describe('or binds tighter than and', () => {
  const cases: Array<{ name: string; value: string; want: boolean }> = [
    { name: 'no event_type, first name', value: '{"src":{"event_data":{"cp":{"name":"Carousel_All"}}}}', want: true },
    { name: 'no event_type, second name', value: '{"src":{"event_data":{"cp":{"name":"CheckingItems"}}}}', want: true },
    {
      name: 'batch event with a wanted name fails the and half',
      value: '{"event_type":"batch","src":{"event_data":{"cp":{"name":"Carousel_All"}}}}',
      want: false,
    },
    {
      name: 'unwanted name fails the or half',
      value: '{"src":{"event_data":{"cp":{"name":"Something_Else"}}}}',
      want: false,
    },
  ]

  cases.forEach(({ name, value, want }) => {
    it(name, () => {
      expect(filterLoadedMessages([message(value)], conditions, 'and')).toHaveLength(want ? 1 : 0)
    })
  })
})

describe('conditions without a joiner keep the old flat modes', () => {
  const flat: KafkaMatchCondition[] = [
    { field: 'a', value: '1', op: 'eq' },
    { field: 'b', value: '2', op: 'eq' },
  ]
  const row = message('{"a":1,"b":99}')

  it('and rejects a message that satisfies only one', () => {
    expect(filterLoadedMessages([row], flat, 'and')).toHaveLength(0)
  })

  it('or accepts a message that satisfies one', () => {
    expect(filterLoadedMessages([row], flat, 'or')).toHaveLength(1)
  })
})

// Mirrors TestNotEqualsMatchesMessagesWithoutTheField in Go: the negation is
// strict, so a message that never carried the field counts as "not batch".
describe('not equals is the strict negation', () => {
  const notBatch: KafkaMatchCondition[] = [{ field: 'event_type', value: 'batch', op: 'not_eq' }]

  it('matches another value', () => {
    expect(filterLoadedMessages([message('{"event_type":"single"}')], notBatch, 'and')).toHaveLength(1)
  })

  it('matches a message without the field', () => {
    expect(filterLoadedMessages([message('{"src":{}}')], notBatch, 'and')).toHaveLength(1)
  })

  it('rejects the excluded value', () => {
    expect(filterLoadedMessages([message('{"event_type":"batch"}')], notBatch, 'and')).toHaveLength(0)
  })
})

// The fixture that pins the precedence: with A and B false and C true,
// "A and B or C" is false under "or binds tighter" and true under the
// conventional left-to-right reading. Every other fixture agrees under both.
describe('precedence is or-tighter, not left-to-right', () => {
  it('A and B or C is false when only C holds', () => {
    const conds: KafkaMatchCondition[] = [
      { field: 'a', value: '', op: 'exists' },
      { field: 'b', value: '', op: 'exists', join: 'and' },
      { field: 'c', value: '', op: 'exists', join: 'or' },
    ]
    expect(filterLoadedMessages([message('{"c":1}')], conds, 'and')).toHaveLength(0)
  })
})

// Mirrors TestNegativesRejectNonJSONPayloads. Negating a helper that fails on
// unparseable input made these include records the server excluded.
describe('negatives reject a payload that is not JSON', () => {
  const textRow = { ...message('plain log line, not json'), format: 'text' } as KafkaMessageRow

  it('not equals', () => {
    const conds: KafkaMatchCondition[] = [{ field: 'event_type', value: 'batch', op: 'not_eq' }]
    expect(filterLoadedMessages([textRow], conds, 'and')).toHaveLength(0)
  })

  it('not contains', () => {
    const conds: KafkaMatchCondition[] = [{ field: 'event_type', value: 'bat', op: 'not_contains' }]
    expect(filterLoadedMessages([textRow], conds, 'and')).toHaveLength(0)
  })
})

// Mirrors TestNegationOverAnArrayRequiresNoElementToMatch.
describe('negation over an array requires no element to match', () => {
  const conds: KafkaMatchCondition[] = [{ field: 'events[].name', value: 'batch', op: 'not_eq' }]
  const cases: Array<{ name: string; value: string; want: number }> = [
    { name: 'no element carries it', value: '{"events":[{"name":"a"},{"name":"b"}]}', want: 1 },
    { name: 'one element among others carries it', value: '{"events":[{"name":"a"},{"name":"batch"}]}', want: 0 },
  ]
  cases.forEach(({ name, value, want }) => {
    it(name, () => {
      expect(filterLoadedMessages([message(value)], conds, 'and')).toHaveLength(want)
    })
  })
})

// A satisfied OR group must not evaluate the rest: each payload predicate parses
// the message again, which on a topic scan is the difference between one parse
// and one per condition.
describe('a satisfied or group short-circuits', () => {
  it('stops after the first member that holds', () => {
    let evaluated = 0
    const counting = new Proxy(message('{"a":1}'), {
      get(target, prop, receiver) {
        if (prop === 'value') evaluated += 1
        return Reflect.get(target, prop, receiver)
      },
    })
    const conds: KafkaMatchCondition[] = [
      { field: 'a', value: '', op: 'exists' },
      { field: 'b', value: '', op: 'exists', join: 'or' },
      { field: 'c', value: '', op: 'exists', join: 'or' },
    ]
    filterLoadedMessages([counting], conds, 'and')
    expect(evaluated).toBe(1)
  })
})
