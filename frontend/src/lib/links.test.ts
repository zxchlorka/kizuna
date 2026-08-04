import { describe, expect, it } from 'vitest'
import {
  connectionLinks,
  extractMessageField,
  isPerElementExtract,
  keyLevelRedisLinks,
  memberRedisLinks,
  selectionRedisLinks,
} from '@/lib/links'
import type { LinkRecord } from '@/types/api'

describe('extractMessageField', () => {
  // Backward compatibility: existing saved links use bare dot-paths and must
  // resolve exactly as they did before the canonical-grammar rewrite.
  it('extracts a top-level scalar (string)', () => {
    expect(extractMessageField('{"user_id":"u-42"}', 'user_id')).toBe('u-42')
  })

  it('extracts a nested dot-path scalar', () => {
    expect(extractMessageField('{"user":{"id":"u-7"}}', 'user.id')).toBe('u-7')
  })

  it('stringifies numeric and boolean leaves', () => {
    expect(extractMessageField('{"n":123}', 'n')).toBe('123')
    expect(extractMessageField('{"ok":true}', 'ok')).toBe('true')
  })

  it('returns null for a missing path', () => {
    expect(extractMessageField('{"user":{"id":1}}', 'user.name')).toBeNull()
  })

  it('returns null for a null leaf', () => {
    expect(extractMessageField('{"src":{"timezone_offset":null}}', 'src.timezone_offset')).toBeNull()
  })

  it('returns null for an object leaf (not a linkable scalar)', () => {
    expect(extractMessageField('{"user":{"id":1}}', 'user')).toBeNull()
  })

  it('returns null for invalid JSON', () => {
    expect(extractMessageField('{not json', 'a')).toBeNull()
  })

  it('returns null for an empty field', () => {
    expect(extractMessageField('{"a":1}', '')).toBeNull()
  })

  // New capability: array wildcards and bracket-notation keys.
  it('extracts the first scalar through an array wildcard', () => {
    expect(
      extractMessageField('{"src":{"event_data":{"events":[{"name":"View"},{"name":"Auth"}]}}}', 'src.event_data.events[].name'),
    ).toBe('View')
  })

  it('addresses a key containing a dot via bracket notation', () => {
    expect(extractMessageField('{"key.with.dot":{"name":"Zulu"}}', '["key.with.dot"].name')).toBe('Zulu')
  })

  it('does not match a dotted key through a plain dot-path', () => {
    expect(extractMessageField('{"key.with.dot":{"name":"Zulu"}}', 'key.with.dot.name')).toBeNull()
  })
})

function link(partial: Partial<LinkRecord>): LinkRecord {
  return {
    id: 'l1',
    source_conn_id: 'redis-1',
    source_kind: 'redis',
    source_scope: 'profile:*',
    target_conn_id: 'redis-1',
    target_kind: 'redis',
    key_pattern: 'c:*',
    ...partial,
  }
}

describe('isPerElementExtract', () => {
  it('is true for member and selection', () => {
    expect(isPerElementExtract('member')).toBe(true)
    expect(isPerElementExtract('selection')).toBe(true)
  })

  it('is false for key-level modes and for undefined', () => {
    expect(isPerElementExtract('value_field')).toBe(false)
    expect(isPerElementExtract('key_capture')).toBe(false)
    expect(isPerElementExtract('string_value')).toBe(false)
    expect(isPerElementExtract(undefined)).toBe(false)
  })
})

describe('selectionRedisLinks', () => {
  const cookies = link({ id: 'c', source_extract: 'selection', source_field: 'cookie_ids', key_pattern: 'c:*' })
  const devices = link({ id: 'd', source_extract: 'selection', source_field: 'device_ids', key_pattern: 'd:*' })
  const anywhere = link({ id: 'any', source_extract: 'selection', key_pattern: 'x:*' })
  const all = [cookies, devices, anywhere]

  it('offers only the link of the field that was clicked', () => {
    expect(selectionRedisLinks(all, 'redis-1', 'profile:42', 'cookie_ids').map((l) => l.id)).toEqual(['c', 'any'])
  })

  it('does not offer a foreign field link', () => {
    expect(selectionRedisLinks(all, 'redis-1', 'profile:42', 'device_ids').map((l) => l.id)).toEqual(['d', 'any'])
  })

  it('offers only field-less links when there is no field (collection element)', () => {
    expect(selectionRedisLinks(all, 'redis-1', 'profile:42', undefined).map((l) => l.id)).toEqual(['any'])
  })

  it('ignores links of another connection', () => {
    expect(selectionRedisLinks(all, 'redis-2', 'profile:42', 'cookie_ids')).toEqual([])
  })

  it('ignores links whose key pattern does not match', () => {
    expect(selectionRedisLinks(all, 'redis-1', 'session:42', 'cookie_ids')).toEqual([])
  })
})

describe('memberRedisLinks and keyLevelRedisLinks', () => {
  const member = link({ id: 'm', source_scope: 'c:*', source_extract: 'member' })
  const selection = link({ id: 's', source_extract: 'selection', source_field: 'cookie_ids' })
  const keyLevel = link({ id: 'k', source_extract: 'value_field', source_field: 'owner_id' })
  const all = [member, selection, keyLevel]

  it('member links are matched by key pattern only', () => {
    expect(memberRedisLinks(all, 'redis-1', 'c:abc').map((l) => l.id)).toEqual(['m'])
  })

  it('key-level links exclude every per-element mode', () => {
    expect(keyLevelRedisLinks(all, 'redis-1', 'profile:42').map((l) => l.id)).toEqual(['k'])
  })
})

// A key, table or topic with no links of its own used to show an empty menu,
// which looks the same as a connection with nothing configured. This group is
// what tells those two apart.
describe('connectionLinks', () => {
  const outgoing = link({ id: 'out', source_conn_id: 'redis-1', target_conn_id: 'kafka-1', target_kind: 'kafka' })
  const incoming = link({ id: 'in', source_conn_id: 'kafka-1', source_kind: 'kafka', target_conn_id: 'redis-1' })
  const elsewhere = link({ id: 'other', source_conn_id: 'pg-9', source_kind: 'postgres', target_conn_id: 'kafka-1', target_kind: 'kafka' })
  const all = [outgoing, incoming, elsewhere]

  it('includes links in both directions, since either end is "on this connection"', () => {
    expect(connectionLinks(all, 'redis-1').map((l) => l.id)).toEqual(['out', 'in'])
  })

  it('leaves out links that never touch the connection', () => {
    expect(connectionLinks(all, 'redis-1').map((l) => l.id)).not.toContain('other')
  })

  it('drops what the menu already lists above it, so the group adds information', () => {
    expect(connectionLinks(all, 'redis-1', [outgoing]).map((l) => l.id)).toEqual(['in'])
  })

  it('is empty for a connection with nothing wired up', () => {
    expect(connectionLinks(all, 'redis-unused')).toEqual([])
  })
})
