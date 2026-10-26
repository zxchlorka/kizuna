import { describe, expect, it } from 'vitest'
import { resetConsequence } from '@/components/kafka/KafkaResetOffsetsDialog'
import type { ObjectItem } from '@/types/api'

const partition = (start: number, end: number) =>
  ({ name: '0', type: 'kafka_partition', meta: { start_offset: start, end_offset: end } }) as unknown as ObjectItem

describe('resetConsequence', () => {
  it('counts what earliest re-reads from the retained range, not from offset zero', () => {
    expect(resetConsequence('earliest', [partition(1000, 1500), partition(0, 700)], 0)).toBe(
      'The group will re-read 1 200 messages from the start of the topic.'
    )
  })

  it('says latest skips exactly the current lag', () => {
    expect(resetConsequence('latest', [partition(0, 10)], 340)).toBe('The group will skip 340 unread messages.')
    expect(resetConsequence('latest', [partition(0, 10)], 0)).toBe('The group is already caught up; nothing will be skipped.')
  })

  it('does not invent a count for a time it cannot resolve client-side', () => {
    expect(resetConsequence('timestamp', [partition(0, 10)], 5)).not.toMatch(/\d/)
  })
})
