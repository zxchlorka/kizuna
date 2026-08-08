import { describe, expect, it } from 'vitest'
import { describeRetentionSize, describeRetentionTime } from '@/lib/kafkaRetention'

describe('describeRetentionSize', () => {
  // The case this exists for: a limit that reads as a topic-wide 233 GiB but
  // actually bounds each of the 12 partitions separately.
  it('multiplies the per-partition limit by the partition count', () => {
    const result = describeRetentionSize('250000000000', 12)
    expect(result.perPartition).toBe('232.83 GiB')
    expect(result.topicTotal).toBe('2.73 TiB')
    expect(result.note).toContain('12 partitions')
  })

  it('keeps the singular for a one-partition topic', () => {
    expect(describeRetentionSize('1073741824', 1).note).toContain('Across 1 partition the')
  })

  it('reports -1 as no size limit rather than a negative one', () => {
    const result = describeRetentionSize('-1', 12)
    expect(result.perPartition).toBeNull()
    expect(result.topicTotal).toBeNull()
    expect(result.note).toContain('No size limit')
  })

  it('withholds the total when the partition count is unknown', () => {
    const result = describeRetentionSize('250000000000', 0)
    expect(result.perPartition).toBe('232.83 GiB')
    expect(result.topicTotal).toBeNull()
  })

  it('reports a missing config as missing, not as unlimited', () => {
    expect(describeRetentionSize(undefined, 12).note).toBe('Not reported by the broker')
  })
})

describe('describeRetentionTime', () => {
  it('renders the Kafka default of seven days', () => {
    expect(describeRetentionTime('604800000')).toBe('7d 0h')
  })

  it('reports -1 as infinite retention', () => {
    expect(describeRetentionTime('-1')).toContain('Kept forever')
  })

  it('distinguishes zero from unlimited', () => {
    expect(describeRetentionTime('0')).toBe('Deleted immediately')
  })

  it('reports a missing config as missing', () => {
    expect(describeRetentionTime(undefined)).toBe('Not reported by the broker')
  })
})
