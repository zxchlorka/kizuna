import { describe, expect, it } from 'vitest'
import { buildSegments, type RedisSlotNode } from '@/components/redis/RedisSlotMap'

function node(address: string, ranges: Array<[number, number]>): RedisSlotNode {
  const slot_ranges = ranges.map(([start, end]) => ({ start, end }))
  return {
    address,
    keys: 0,
    used_memory: 0,
    maxmemory: 0,
    connected_clients: 0,
    slots: slot_ranges.reduce((sum, r) => sum + r.end - r.start + 1, 0),
    slot_ranges,
    replicas: 0,
  }
}

const owners = (segments: ReturnType<typeof buildSegments>) =>
  segments.map((s) => [s.node?.address ?? 'GAP', s.start, s.end] as const)

describe('buildSegments', () => {
  it('covers a whole cluster with no gaps', () => {
    const segments = buildSegments([
      node('a', [[0, 5460]]),
      node('b', [[5461, 10922]]),
      node('c', [[10923, 16383]]),
    ])
    expect(owners(segments)).toEqual([
      ['a', 0, 5460],
      ['b', 5461, 10922],
      ['c', 10923, 16383],
    ])
    expect(segments.reduce((sum, s) => sum + s.slots, 0)).toBe(16384)
  })

  // The state the ribbon exists for: a master dropped out and its slots answer
  // to nobody. Every node still listed looks healthy, so only the hole shows it.
  it('marks a hole in the middle where it actually is', () => {
    const segments = buildSegments([node('a', [[0, 5460]]), node('c', [[10923, 16383]])])
    expect(owners(segments)).toEqual([
      ['a', 0, 5460],
      ['GAP', 5461, 10922],
      ['c', 10923, 16383],
    ])
  })

  it('marks a missing tail', () => {
    const segments = buildSegments([node('a', [[0, 9999]])])
    expect(owners(segments)).toEqual([
      ['a', 0, 9999],
      ['GAP', 10000, 16383],
    ])
  })

  it('marks a missing head', () => {
    const segments = buildSegments([node('a', [[100, 16383]])])
    expect(owners(segments)).toEqual([
      ['GAP', 0, 99],
      ['a', 100, 16383],
    ])
  })

  // After a few reshards one master owns disjoint spans. They must be laid out
  // in slot order, not grouped by owner, or the ribbon stops matching the
  // keyspace it is drawing.
  it('interleaves fragmented ranges in slot order', () => {
    const segments = buildSegments([
      node('a', [
        [0, 999],
        [8000, 16383],
      ]),
      node('b', [[1000, 7999]]),
    ])
    expect(owners(segments)).toEqual([
      ['a', 0, 999],
      ['b', 1000, 7999],
      ['a', 8000, 16383],
    ])
    expect(segments.reduce((sum, s) => sum + s.slots, 0)).toBe(16384)
  })

  it('reports one full gap when nothing is assigned', () => {
    expect(owners(buildSegments([]))).toEqual([['GAP', 0, 16383]])
  })
})
