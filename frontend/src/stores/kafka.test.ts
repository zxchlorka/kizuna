import { describe, expect, it } from 'vitest'
import { filterLoadedMessages, type KafkaMessageRow } from '@/stores/kafka'

// Minimal row factory — filterLoadedMessages only reads `value` (+ identity via
// partition/offset), so the other fields are placeholders.
function row(partition: number, offset: number, value: string, format = 'json'): KafkaMessageRow {
  return { partition, offset, timestamp: '', key: '', value, format }
}

// The plan's real fixture shape: src.event_data.events[].name, with "Auth" as
// the search/filter target. Kept identical to the cross-language grammar tests.
const authDoc = '{"src":{"event_data":{"events":[{"name":"View"},{"name":"Auth"}]}}}'
const viewOnlyDoc = '{"src":{"event_data":{"events":[{"name":"View"}]}}}'

describe('filterLoadedMessages', () => {
  it('returns the input unchanged for an empty path (no filtering)', () => {
    const messages = [row(0, 1, authDoc), row(0, 2, viewOnlyDoc)]
    expect(filterLoadedMessages(messages, [{ field: '', value: 'anything', op: 'eq' }])).toBe(messages)
    expect(filterLoadedMessages(messages, [{ field: '   ', value: 'anything', op: 'eq' }])).toBe(messages)
  })

  it('keeps only rows whose nested-array leaf equals the value (docs/msg.json fixture)', () => {
    const messages = [row(0, 1, authDoc), row(1, 5, viewOnlyDoc), row(2, 9, authDoc)]
    const matches = filterLoadedMessages(messages, [{ field: 'src.event_data.events[].name', value: 'Auth', op: 'eq' }])
    expect(matches.map((m) => `${m.partition}:${m.offset}`)).toEqual(['0:1', '2:9'])
  })

  it('returns no rows when nothing matches the value', () => {
    const messages = [row(0, 1, authDoc), row(0, 2, viewOnlyDoc)]
    expect(filterLoadedMessages(messages, [{ field: 'src.event_data.events[].name', value: 'Nope', op: 'eq' }])).toEqual([])
  })

  it('excludes non-JSON rows (they never match a non-empty path)', () => {
    const messages = [row(0, 1, authDoc), row(0, 2, 'not json at all', 'text')]
    const matches = filterLoadedMessages(messages, [{ field: 'src.event_data.events[].name', value: 'Auth', op: 'eq' }])
    expect(matches).toHaveLength(1)
    expect(matches[0].offset).toBe(1)
  })

  it('does not mutate the input array', () => {
    const messages = [row(0, 1, authDoc), row(0, 2, viewOnlyDoc)]
    const snapshot = [...messages]
    filterLoadedMessages(messages, [{ field: 'src.event_data.events[].name', value: 'Auth', op: 'eq' }])
    expect(messages).toEqual(snapshot)
  })

  it('matches a top-level scalar path', () => {
    const messages = [row(0, 1, '{"event_type":"batch"}'), row(0, 2, '{"event_type":"single"}')]
    const matches = filterLoadedMessages(messages, [{ field: 'event_type', value: 'batch', op: 'eq' }])
    expect(matches).toHaveLength(1)
    expect(matches[0].offset).toBe(1)
  })
})

describe('filterLoadedMessages with several conditions', () => {
  const signup = '{"user":{"id":"42"},"event":"signup"}'
  const logout = '{"user":{"id":"7"},"event":"logout"}'
  const messages = [row(0, 1, signup), row(0, 2, logout)]

  const idIs42 = { field: 'user.id', value: '42', op: 'eq' as const }
  const eventIsLogout = { field: 'event', value: 'logout', op: 'eq' as const }

  it('and keeps only rows satisfying every condition', () => {
    expect(filterLoadedMessages(messages, [idIs42, eventIsLogout], 'and')).toEqual([])
  })

  it('or keeps rows satisfying any condition', () => {
    const matches = filterLoadedMessages(messages, [idIs42, eventIsLogout], 'or')
    expect(matches.map((m) => m.offset)).toEqual([1, 2])
  })

  // A half-filled row in the filter dialog must narrow nothing rather than
  // matching everything and quietly widening the result.
  it('ignores a condition with no field', () => {
    const matches = filterLoadedMessages(messages, [idIs42, { field: '  ', value: 'x', op: 'eq' }], 'and')
    expect(matches.map((m) => m.offset)).toEqual([1])
  })
})
