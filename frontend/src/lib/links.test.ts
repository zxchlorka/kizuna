import { describe, expect, it } from 'vitest'
import { extractMessageField } from '@/lib/links'

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
