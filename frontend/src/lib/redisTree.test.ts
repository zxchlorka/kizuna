import { describe, expect, it } from 'vitest'
import { buildRedisTree } from '@/lib/redisTree'
import type { ObjectItem } from '@/types/api'

const key = (path: string): ObjectItem =>
  ({ name: path, path, type: 'redis_string', row_count: 0 }) as unknown as ObjectItem

describe('buildRedisTree', () => {
  it('groups by the separator and counts every key beneath a namespace', () => {
    const tree = buildRedisTree([key('profile:1'), key('profile:2'), key('session:9')], ':')

    expect(tree.namespaces.map((n) => n.name)).toEqual(['profile', 'session'])
    expect(tree.namespaces[0].keyCount).toBe(2)
    expect(tree.namespaces[0].keys.map((k) => k.name)).toEqual(['1', '2'])
    expect(tree.keyCount).toBe(3)
  })

  it('nests deeper levels', () => {
    const tree = buildRedisTree([key('a:b:c'), key('a:b:d'), key('a:e')], ':')

    const a = tree.namespaces[0]
    expect(a.path).toBe('a')
    expect(a.keys.map((k) => k.name)).toEqual(['e'])
    const b = a.namespaces[0]
    expect(b.path).toBe('a:b')
    expect(b.keys.map((k) => k.name)).toEqual(['c', 'd'])
    expect(a.keyCount).toBe(3)
  })

  it('keeps a key with no separator at the root', () => {
    const tree = buildRedisTree([key('lonely'), key('ns:one')], ':')

    expect(tree.keys.map((k) => k.name)).toEqual(['lonely'])
    expect(tree.namespaces.map((n) => n.name)).toEqual(['ns'])
  })

  // "a:b:" is a real key whose last segment is empty. It belongs under a:b, and
  // it falls back to its full name rather than rendering as a blank row.
  it('keeps a key whose last segment is empty, under its namespace', () => {
    const tree = buildRedisTree([key('a:b:')], ':')

    const b = tree.namespaces[0].namespaces[0]
    expect(b.path).toBe('a:b')
    expect(b.keys.map((k) => k.name)).toEqual(['a:b:'])
  })

  // An empty segment in the middle ("a::b") must not become a nameless folder
  // that cannot be told apart from its neighbours.
  it('stops descending at an empty middle segment', () => {
    const tree = buildRedisTree([key('a::b')], ':')

    const a = tree.namespaces[0]
    expect(a.namespaces).toEqual([])
    // Inside folder "a" what is left of the key is ":b" — the same rule that
    // renders "profile:1" as "1".
    expect(a.keys.map((k) => k.name)).toEqual([':b'])
  })

  it('counts a namespace by its keys, not by its sub-namespaces', () => {
    const tree = buildRedisTree([key('x:1'), key('x:y:2'), key('x:y:3')], ':')

    expect(tree.namespaces[0].keyCount).toBe(3)
    expect(tree.namespaces[0].namespaces[0].keyCount).toBe(2)
  })
})
