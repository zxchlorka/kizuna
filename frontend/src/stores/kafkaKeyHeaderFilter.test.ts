import { describe, expect, it } from 'vitest'
import { activeConditions, filterLoadedMessages, type KafkaMessageRow } from '@/stores/kafka'

// "Filter loaded" and "Search topic" must agree about what matches, so these
// cases are the twins of TestMessageMatchesFilterOnKeyAndHeaders in
// internal/connector/kafka/key_header_filter_test.go. A disagreement between the
// two has been a real bug here before.
function record(
  offset: number,
  fields: Partial<Pick<KafkaMessageRow, 'key' | 'value' | 'format' | 'headers'>>
): KafkaMessageRow {
  return {
    partition: 0,
    offset,
    timestamp: '',
    key: '',
    value: '{}',
    format: 'json',
    ...fields,
  }
}

const binary = record(1, {
  key: 'user-42',
  value: 'AQIDBA==',
  format: 'binary',
  headers: { 'trace-id': 'abc-123-def', source: 'checkout' },
})
const keyless = record(2, { key: '', value: '{}' })

describe('filtering by key', () => {
  it('matches an exact key even when the payload is binary', () => {
    const matches = filterLoadedMessages([binary, keyless], [
      { field: '', value: 'user-42', op: 'eq', target: 'key' },
    ])
    expect(matches.map((m) => m.offset)).toEqual([1])
  })

  it('does not match a prefix under equals', () => {
    expect(
      filterLoadedMessages([binary], [{ field: '', value: 'user-4', op: 'eq', target: 'key' }])
    ).toEqual([])
  })

  it('matches a substring under contains', () => {
    const matches = filterLoadedMessages([binary, keyless], [
      { field: '', value: '-42', op: 'contains', target: 'key' },
    ])
    expect(matches.map((m) => m.offset)).toEqual([1])
  })

  it('separates a keyless record from an empty key', () => {
    expect(
      filterLoadedMessages([binary, keyless], [{ field: '', value: '', op: 'missing', target: 'key' }]).map(
        (m) => m.offset
      )
    ).toEqual([2])
    expect(
      filterLoadedMessages([binary, keyless], [{ field: '', value: '', op: 'exists', target: 'key' }]).map(
        (m) => m.offset
      )
    ).toEqual([1])
  })

  it('counts a key condition as complete without a field', () => {
    expect(activeConditions([{ field: '', value: 'x', op: 'eq', target: 'key' }])).toHaveLength(1)
    expect(activeConditions([{ field: '', value: 'x', op: 'eq', target: 'header' }])).toHaveLength(0)
    expect(activeConditions([{ field: '', value: 'x', op: 'eq' }])).toHaveLength(0)
  })
})

describe('filtering by header', () => {
  it('matches a header value', () => {
    const matches = filterLoadedMessages([binary, keyless], [
      { field: 'source', value: 'checkout', op: 'eq', target: 'header' },
    ])
    expect(matches.map((m) => m.offset)).toEqual([1])
  })

  it('matches part of a header value', () => {
    const matches = filterLoadedMessages([binary], [
      { field: 'trace-id', value: '123', op: 'contains', target: 'header' },
    ])
    expect(matches).toHaveLength(1)
  })

  it('reports a header absent on a record carrying none', () => {
    const matches = filterLoadedMessages([binary, keyless], [
      { field: 'trace-id', value: '', op: 'exists', target: 'header' },
    ])
    expect(matches.map((m) => m.offset)).toEqual([1])
  })

  it('treats header names as case-sensitive, as Kafka does', () => {
    expect(
      filterLoadedMessages([binary], [{ field: 'Source', value: '', op: 'exists', target: 'header' }])
    ).toEqual([])
  })
})

describe('contains inside the payload', () => {
  const doc = record(3, { value: '{"url":"https://example.test/checkout?trace=abc-123","attempts":42}' })

  it('matches a substring of a string leaf', () => {
    expect(
      filterLoadedMessages([doc], [{ field: 'url', value: 'trace=abc-123', op: 'contains' }])
    ).toHaveLength(1)
  })

  it('searches a number leaf as its rendered text', () => {
    expect(filterLoadedMessages([doc], [{ field: 'attempts', value: '4', op: 'contains' }])).toHaveLength(1)
  })

  it('does not match an absent substring', () => {
    expect(filterLoadedMessages([doc], [{ field: 'url', value: 'nope', op: 'contains' }])).toEqual([])
  })
})
