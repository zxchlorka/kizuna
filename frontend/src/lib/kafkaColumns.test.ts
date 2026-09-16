import { describe, expect, it } from 'vitest'
import { columnLabel, columnValues, formatLeaves, NO_VALUE } from '@/lib/kafkaColumns'

// The shape from events_v2: two kinds of message in one topic, one carrying
// src.event_data.cp and the other src.event_data.events[].
const withEvents = JSON.stringify({
  event_type: 'batch',
  src: { event_data: { events: [{ name: 'View_Item' }, { name: 'Auth' }, { name: 'Scroll' }] } },
})
const withCp = JSON.stringify({
  event_type: 'Carousel_All',
  src: { event_data: { cp: { name: 'Carousel_All' } } },
})

const PATHS = ['event_type', 'src.event_data.cp.name', 'src.event_data.events[].name']

describe('columnValues', () => {
  it('names the first two of an array and counts the rest', () => {
    expect(columnValues(withEvents, 'json', PATHS)).toEqual(['batch', NO_VALUE, 'View_Item, Auth +1'])
  })

  it('leaves a dash where the path resolves to nothing', () => {
    expect(columnValues(withCp, 'json', PATHS)).toEqual(['Carousel_All', 'Carousel_All', NO_VALUE])
  })

  // A record whose body is text or protobuf has no JSON fields at all; every
  // column is a dash rather than a crash or an empty cell that reads as "".
  it('answers a non-JSON payload with dashes', () => {
    expect(columnValues('plain log line', 'text', PATHS)).toEqual([NO_VALUE, NO_VALUE, NO_VALUE])
  })

  it('answers a payload that claims json but does not parse', () => {
    expect(columnValues('{not json', 'json', PATHS)).toEqual([NO_VALUE, NO_VALUE, NO_VALUE])
  })

  it('does nothing when no columns are chosen', () => {
    expect(columnValues(withEvents, 'json', [])).toEqual([])
  })

  // The whole point of the lossless parse: a snowflake id in a column must be
  // the id that is in the message, not the one a double rounds it to.
  it('keeps an int64 exact', () => {
    const payload = '{"profile_id":2091885016401416192}'
    expect(columnValues(payload, 'json', ['profile_id'])).toEqual(['2091885016401416192'])
  })

  // A container is not a cell value — printing "[object Object]" would be worse
  // than saying there is nothing scalar here.
  it('skips a leaf that is an object or an array', () => {
    expect(columnValues('{"a":{"b":1}}', 'json', ['a'])).toEqual([NO_VALUE])
  })
})

describe('formatLeaves', () => {
  const cases: Array<{ name: string; values: string[]; want: string }> = [
    { name: 'nothing', values: [], want: NO_VALUE },
    { name: 'one', values: ['View_Item'], want: 'View_Item' },
    { name: 'two', values: ['View_Item', 'Auth'], want: 'View_Item, Auth' },
    { name: 'five', values: ['a', 'b', 'c', 'd', 'e'], want: 'a, b +3' },
  ]
  cases.forEach(({ name, values, want }) => {
    it(name, () => expect(formatLeaves(values)).toBe(want))
  })
})

describe('columnLabel', () => {
  it('keeps a short path whole', () => {
    expect(columnLabel('event_type')).toBe('event_type')
  })

  // Full paths share a long prefix; the tail is what tells two columns apart.
  it('shortens a long path to its last two segments', () => {
    expect(columnLabel('src.event_data.cp.name')).toBe('…cp.name')
    expect(columnLabel('src.event_data.events[].name')).toBe('…events[].name')
  })
})
