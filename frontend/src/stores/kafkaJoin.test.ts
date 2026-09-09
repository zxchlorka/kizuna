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
