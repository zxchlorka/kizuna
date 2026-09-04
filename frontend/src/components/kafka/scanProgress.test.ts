import { describe, expect, it } from 'vitest'
import { formatScanShare, seekIsBlind } from '@/components/kafka/KafkaMessageBrowser'

describe('formatScanShare', () => {
  // The case that started this: 3.77M scanned out of 12.6 billion. Rendered as
  // "0.0%" it reads as a broken counter; the point is that it is a sliver.
  it('names a sliver instead of rounding it to zero', () => {
    expect(formatScanShare(3_770_403, 12_640_499_950)).toBe('<0.1% of the topic')
  })

  it('keeps one decimal while the share is small', () => {
    expect(formatScanShare(500_000, 10_000_000)).toBe('5.0% of the topic')
  })

  it('drops the decimal once the share is large', () => {
    expect(formatScanShare(9_000_000, 10_000_000)).toBe('90% of the topic')
  })

  it('says nothing when the topic size is unknown', () => {
    expect(formatScanShare(1000, 0)).toBe('')
  })
})

describe('seekIsBlind', () => {
  const noSeek = { offset: '', timestamp: '' }

  it('warns on a huge topic with no anchor', () => {
    expect(seekIsBlind(12_640_499_950, noSeek)).toBe(true)
  })

  it('stays quiet once a time or an offset says where to start', () => {
    expect(seekIsBlind(12_640_499_950, { offset: '', timestamp: '2026-08-28T09:04:00Z' })).toBe(false)
    expect(seekIsBlind(12_640_499_950, { offset: '4200', timestamp: '' })).toBe(false)
  })

  // A whitespace-only field is not an anchor, and treating it as one would
  // silence the warning exactly when the scan is least likely to find anything.
  it('does not count blank input as an anchor', () => {
    expect(seekIsBlind(12_640_499_950, { offset: '  ', timestamp: ' ' })).toBe(true)
  })

  it('stays quiet on a topic a full walk can still cover', () => {
    expect(seekIsBlind(120_000, noSeek)).toBe(false)
  })
})
