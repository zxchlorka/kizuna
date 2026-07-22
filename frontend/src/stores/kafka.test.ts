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
    expect(filterLoadedMessages(messages, '', 'anything')).toBe(messages)
    expect(filterLoadedMessages(messages, '   ', 'anything')).toBe(messages)
  })

  it('keeps only rows whose nested-array leaf equals the value (docs/msg.json fixture)', () => {
    const messages = [row(0, 1, authDoc), row(1, 5, viewOnlyDoc), row(2, 9, authDoc)]
    const matches = filterLoadedMessages(messages, 'src.event_data.events[].name', 'Auth')
    expect(matches.map((m) => `${m.partition}:${m.offset}`)).toEqual(['0:1', '2:9'])
  })

  it('returns no rows when nothing matches the value', () => {
    const messages = [row(0, 1, authDoc), row(0, 2, viewOnlyDoc)]
    expect(filterLoadedMessages(messages, 'src.event_data.events[].name', 'Nope')).toEqual([])
  })

  it('excludes non-JSON rows (they never match a non-empty path)', () => {
    const messages = [row(0, 1, authDoc), row(0, 2, 'not json at all', 'text')]
    const matches = filterLoadedMessages(messages, 'src.event_data.events[].name', 'Auth')
    expect(matches).toHaveLength(1)
    expect(matches[0].offset).toBe(1)
  })

  it('does not mutate the input array', () => {
    const messages = [row(0, 1, authDoc), row(0, 2, viewOnlyDoc)]
    const snapshot = [...messages]
    filterLoadedMessages(messages, 'src.event_data.events[].name', 'Auth')
    expect(messages).toEqual(snapshot)
  })

  it('matches a top-level scalar path', () => {
    const messages = [row(0, 1, '{"event_type":"batch"}'), row(0, 2, '{"event_type":"single"}')]
    const matches = filterLoadedMessages(messages, 'event_type', 'batch')
    expect(matches).toHaveLength(1)
    expect(matches[0].offset).toBe(1)
  })
})
