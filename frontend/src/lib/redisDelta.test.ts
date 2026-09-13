import { describe, expect, it } from 'vitest'
import { describeDelta, isEmptyDelta } from '@/lib/redisDelta'
import type { TableRow } from '@/types/api'

const hash = (pairs: Record<string, string>): TableRow[] =>
  Object.entries(pairs).map(([field, value]) => ({ field, value }))

describe('describeDelta on a hash', () => {
  // The live-test case: poke the service, refresh, see that the gaid landed.
  it('reports a field that appeared', () => {
    const delta = describeDelta('redis_hash', hash({ country_code: 'RU' }), hash({ country_code: 'RU', gaid_ids: 'manual-c6-gaid' }))
    expect(delta.added).toEqual([{ id: 'gaid_ids', value: 'manual-c6-gaid' }])
    expect(delta.changed).toEqual([])
    expect(delta.removed).toEqual([])
  })

  it('reports a field that changed, with what it was', () => {
    const delta = describeDelta('redis_hash', hash({ updated_at: '1787579358' }), hash({ updated_at: '1787907913' }))
    expect(delta.changed).toEqual([{ id: 'updated_at', value: '1787907913', previous: '1787579358' }])
  })

  it('reports a field that went away', () => {
    const delta = describeDelta('redis_hash', hash({ wb_user_id: '770006' }), hash({}))
    expect(delta.removed).toEqual([{ id: 'wb_user_id' }])
  })

  it('says nothing when nothing moved', () => {
    const same = hash({ country_code: 'RU', updated_at: '1787907913' })
    expect(isEmptyDelta(describeDelta('redis_hash', same, same))).toBe(true)
  })
})

describe('describeDelta respects what each type can actually do', () => {
  // A set member has no value, so it can only appear or disappear. Comparing it
  // to itself would report a change that cannot happen.
  it('a set reports membership only', () => {
    const delta = describeDelta(
      'redis_set',
      [{ member: 'x' }, { member: 'y' }],
      [{ member: 'x' }, { member: 'z' }]
    )
    expect(delta.added).toEqual([{ id: 'z', value: undefined }])
    expect(delta.removed).toEqual([{ id: 'y' }])
    expect(delta.changed).toEqual([])
  })

  // A zset member keeps its name and moves its score — the opposite case.
  it('a zset reports a moved score as a change, not a re-add', () => {
    const delta = describeDelta(
      'redis_zset',
      [{ member: '2093263633890222080', score: 1787579358 }],
      [{ member: '2093263633890222080', score: 1787907913 }]
    )
    expect(delta.changed).toEqual([
      { id: '2093263633890222080', value: '1787907913', previous: '1787579358' },
    ])
    expect(delta.added).toEqual([])
  })

  it('a string compares its single value', () => {
    const delta = describeDelta('redis_string', [{ value: 'hello' }], [{ value: 'world' }])
    expect(delta.changed).toEqual([{ id: 'value', value: 'world', previous: 'hello' }])
  })

  // Entries are immutable once written, so only arrivals are possible.
  it('a stream reports arrivals', () => {
    const delta = describeDelta(
      'redis_stream',
      [{ id: '1700000000000-0' }],
      [{ id: '1700000000000-0' }, { id: '1700000000001-0' }]
    )
    expect(delta.added).toEqual([{ id: '1700000000001-0', value: undefined }])
    expect(delta.changed).toEqual([])
  })
})

// int64 ids arrive as strings from the lossless parse, so comparison is
// character-for-character and two neighbouring snowflakes stay distinct. Through
// a Number they would both round to …200 and the delta would say "no change".
describe('describeDelta keeps large ids distinct', () => {
  it('sees a moved snowflake', () => {
    const delta = describeDelta(
      'redis_hash',
      hash({ profile_id: '2091885016401416192' }),
      hash({ profile_id: '2091885016401416199' })
    )
    expect(delta.changed).toHaveLength(1)
    expect(delta.changed[0].previous).toBe('2091885016401416192')
  })
})

// Found in review: two PAGES were being compared, not two keys, so anything that
// left the window was announced as deleted. For a stream that broke the feature's
// own scenario — it is read as the last N entries, and every arrival pushes an
// older one out of sight.
describe('a windowed view never claims a deletion', () => {
  it('a stream reports arrivals and stays silent about what fell off the tail', () => {
    const before = [{ id: '1700000000151-0' }, { id: '1700000000152-0' }]
    const after = [{ id: '1700000000152-0' }, { id: '1700000000203-0' }]

    const windowed = describeDelta('redis_stream', before, after, false)
    expect(windowed.added).toEqual([{ id: '1700000000203-0', value: undefined }])
    expect(windowed.removed).toEqual([])

    // On a complete key the same disappearance is a real deletion.
    const whole = describeDelta('redis_stream', before, after, true)
    expect(whole.removed).toEqual([{ id: '1700000000151-0' }])
  })

  it('a paged hash does not bury the field that scrolled off', () => {
    const before = hash({ f48: 'x', f49: 'y' })
    const after = hash({ aaa: 'new', f48: 'x' })

    const windowed = describeDelta('redis_hash', before, after, false)
    expect(windowed.added).toEqual([{ id: 'aaa', value: 'new' }])
    expect(windowed.removed).toEqual([])
  })

  it('changes are still reported on a windowed view — the row is in both', () => {
    const delta = describeDelta('redis_hash', hash({ updated_at: '1' }), hash({ updated_at: '2' }), false)
    expect(delta.changed).toEqual([{ id: 'updated_at', value: '2', previous: '1' }])
  })
})
