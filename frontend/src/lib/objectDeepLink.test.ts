import { describe, expect, it } from 'vitest'
import { decodeObjectDeepLink, encodeObjectDeepLink } from '@/lib/objectDeepLink'

describe('objectDeepLink', () => {
  it('round-trips an object with no filters', () => {
    const params = encodeObjectDeepLink({ object: 'public.users', objectType: 'table', filters: [] })
    expect(params.toString()).toBe('object=public.users&type=table')
    expect(decodeObjectDeepLink(params)).toEqual({
      object: 'public.users',
      objectType: 'table',
      filters: [],
    })
  })

  it('round-trips filters', () => {
    const filters = [
      { column: 'id', op: 'eq' as const, value: '123' },
      { column: 'status', op: 'contains' as const, value: 'act' },
    ]
    const decoded = decodeObjectDeepLink(
      encodeObjectDeepLink({ object: 'public.users', objectType: 'table', filters })
    )
    expect(decoded?.filters).toEqual(filters)
  })

  it('keeps a value that contains the separator', () => {
    const filters = [{ column: 'created_at', op: 'gte' as const, value: '2026-08-19T10:30:00.500Z' }]
    const decoded = decodeObjectDeepLink(
      encodeObjectDeepLink({ object: 'events', objectType: 'table', filters })
    )
    expect(decoded?.filters).toEqual(filters)
  })

  it('carries a Redis key with colons and a Kafka topic', () => {
    const key = decodeObjectDeepLink(
      encodeObjectDeepLink({ object: 'profile:1234:meta', objectType: 'redis_hash', filters: [] })
    )
    expect(key).toEqual({ object: 'profile:1234:meta', objectType: 'redis_hash', filters: [] })

    const topic = decodeObjectDeepLink(
      encodeObjectDeepLink({ object: 'orders.v2', objectType: 'kafka_topic', filters: [] })
    )
    expect(topic?.objectType).toBe('kafka_topic')
  })

  it('has no link without an object', () => {
    expect(decodeObjectDeepLink(new URLSearchParams(''))).toBeNull()
    expect(decodeObjectDeepLink(new URLSearchParams('type=table'))).toBeNull()
    expect(encodeObjectDeepLink(null).toString()).toBe('')
  })

  describe('a link from someone else', () => {
    it('falls back to table for an unknown object type', () => {
      expect(decodeObjectDeepLink(new URLSearchParams('object=x&type=nonsense'))?.objectType).toBe('table')
    })

    it('drops a filter with an operator it does not know', () => {
      const decoded = decodeObjectDeepLink(
        new URLSearchParams('object=x&type=table&filter=id.drop_table.1&filter=id.eq.2')
      )
      expect(decoded?.filters).toEqual([{ column: 'id', op: 'eq', value: '2' }])
    })

    it('drops a malformed filter', () => {
      const decoded = decodeObjectDeepLink(
        new URLSearchParams('object=x&type=table&filter=nodots&filter=.eq.1&filter=one.dot')
      )
      expect(decoded?.filters).toEqual([])
    })
  })

  it('omits a filter whose column contains the separator rather than mangling it', () => {
    const params = encodeObjectDeepLink({
      object: 'x',
      objectType: 'table',
      filters: [
        { column: 'odd.column', op: 'eq', value: '1' },
        { column: 'id', op: 'eq', value: '2' },
      ],
    })
    expect(params.getAll('filter')).toEqual(['id.eq.2'])
  })
})
