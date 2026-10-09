import { describe, expect, it } from 'vitest'
import { exportFileName, formatIdList, idWithoutPrefix } from '@/lib/redisKeyExport'

describe('idWithoutPrefix', () => {
  it('drops the namespace the file is already named after', () => {
    expect(idWithoutPrefix('idfa:00584dbd-4a2e', 'idfa', ':')).toBe('00584dbd-4a2e')
  })

  // A nested namespace keeps everything below the level being exported.
  it('strips only the exported level', () => {
    expect(idWithoutPrefix('user:session:abc', 'user', ':')).toBe('session:abc')
  })

  // Defensive: the scan is driven by `idfa:*`, so a key without the prefix
  // should never arrive — but inventing a truncation would be worse than
  // passing it through whole.
  it('leaves a key without the prefix alone', () => {
    expect(idWithoutPrefix('other:1', 'idfa', ':')).toBe('other:1')
  })

  it('honours a non-default separator', () => {
    expect(idWithoutPrefix('idfa|abc', 'idfa', '|')).toBe('abc')
  })
})

describe('formatIdList', () => {
  it('writes one id per line so the file greps and diffs', () => {
    expect(formatIdList(['a', 'b'])).toBe('[\n  "a",\n  "b"\n]\n')
  })

  it('escapes what JSON requires', () => {
    expect(formatIdList(['a"b'])).toBe('[\n  "a\\"b"\n]\n')
  })

  // An empty namespace yields a valid, honest file rather than nothing.
  it('stays valid JSON when there is nothing to write', () => {
    expect(formatIdList([])).toBe('[]\n')
    expect(JSON.parse(formatIdList([]))).toEqual([])
  })

  it('round-trips through JSON.parse', () => {
    const ids = ['00584dbd-4a2e', 'b/c', 'ключ']
    expect(JSON.parse(formatIdList(ids))).toEqual(ids)
  })
})

describe('exportFileName', () => {
  it('names the file after the namespace', () => {
    expect(exportFileName('idfa')).toBe('idfa.json')
  })

  // A nested namespace must not turn into a path: `user:session.json` would be
  // read as a directory by some tools and refused by others.
  it('flattens separators instead of making a path', () => {
    expect(exportFileName('user:session')).toBe('user-session.json')
    expect(exportFileName('a/b')).toBe('a-b.json')
  })

  it('falls back rather than producing a nameless file', () => {
    expect(exportFileName(':::')).toBe('keys.json')
  })
})
