import { describe, expect, it } from 'vitest'
import { buildMessageFilters, kafkaFieldExportUrl } from '@/stores/kafka'

function column(filters: { column: string; value: string }[], name: string): string | undefined {
  return filters.find((filter) => filter.column === name)?.value
}

describe('buildMessageFilters', () => {
  it('carries partition, direction and seek without a pagination cursor', () => {
    const filters = buildMessageFilters(1, { offset: '5', timestamp: '' }, 'oldest', null)
    expect(column(filters, 'partition')).toBe('1')
    expect(column(filters, 'order')).toBe('oldest')
    expect(column(filters, 'from_offset')).toBe('5')
    expect(filters.some((filter) => filter.column.endsWith('_offsets'))).toBe(false)
  })

  it('leaves newest and an empty seek out', () => {
    expect(buildMessageFilters(null, { offset: '', timestamp: '' }, 'newest', null)).toEqual([])
  })

  it('numbers every condition after the first', () => {
    const filters = buildMessageFilters(null, null, 'newest', {
      conditions: [
        { field: 'kind', value: 'a', op: 'eq' },
        { field: 'user.id', value: '7', op: 'eq', join: 'or' },
      ],
      mode: 'and',
    })
    expect(column(filters, 'match_field')).toBe('kind')
    expect(column(filters, 'match_field.1')).toBe('user.id')
    expect(column(filters, 'match_join.1')).toBe('or')
    expect(column(filters, 'match_mode')).toBe('and')
  })
})

describe('kafkaFieldExportUrl', () => {
  it('escapes the topic and sends fields as JSON', () => {
    const url = new URL(kafkaFieldExportUrl('c1', 'a.b/c', ['user_id'], []), 'http://x')
    expect(url.pathname).toBe('/api/connections/c1/objects/a.b%2Fc/fields.csv')
    expect(url.searchParams.get('fields')).toBe('["user_id"]')
    expect(url.searchParams.has('filters')).toBe(false)
  })

  it('names the export when given an id', () => {
    const url = new URL(kafkaFieldExportUrl('c1', 't', ['a'], [], 'abc123'), 'http://x')
    expect(url.searchParams.get('export_id')).toBe('abc123')
  })

  it('sends filters when there are any', () => {
    const url = new URL(kafkaFieldExportUrl('c1', 't', ['a', 'b'], [{ column: 'partition', op: 'eq', value: '2' }]), 'http://x')
    expect(JSON.parse(url.searchParams.get('filters') ?? '[]')).toEqual([{ column: 'partition', op: 'eq', value: '2' }])
  })
})
