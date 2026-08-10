import { describe, expect, it } from 'vitest'
import {
  formatBytes,
  formatCompactCount,
  formatDurationSeconds,
  formatExactCount,
  splitSharedPrefix,
} from '@/lib/numberFormat'

describe('formatCompactCount', () => {
  const cases: Array<{ name: string; value: number; want: string }> = [
    { name: 'zero', value: 0, want: '0' },
    { name: 'small values stay exact', value: 42, want: '42' },
    // Below the threshold single units still carry meaning, so no rounding.
    { name: 'just under the compact threshold', value: 9999, want: '9 999' },
    { name: 'thousands', value: 10000, want: '10K' },
    { name: 'lag from the screenshot', value: 9729467, want: '9.73M' },
    { name: 'group total lag', value: 168230789, want: '168.23M' },
    { name: 'a twelve digit offset', value: 137771731278, want: '137.77B' },
  ]

  for (const tc of cases) {
    it(tc.name, () => {
      expect(formatCompactCount(tc.value)).toBe(tc.want)
    })
  }
})

describe('formatExactCount', () => {
  it('groups digits with spaces rather than commas', () => {
    expect(formatExactCount(137771731278)).toBe('137 771 731 278')
  })
})

describe('splitSharedPrefix', () => {
  it('dims the digits a committed/end offset pair have in common', () => {
    const committed = formatExactCount(137771731278)
    const end = formatExactCount(137781460745)

    expect(splitSharedPrefix(committed, end)).toEqual({ prefix: '137 7', rest: '71 731 278' })
    expect(splitSharedPrefix(end, committed)).toEqual({ prefix: '137 7', rest: '81 460 745' })
  })

  it('highlights everything when the magnitudes differ', () => {
    // No digit-for-digit correspondence, so there is no honest shared prefix.
    expect(splitSharedPrefix('9 999', '10 000')).toEqual({ prefix: '', rest: '9 999' })
  })

  it('highlights everything when the values are equal', () => {
    // A caught-up partition has no differing part to point at.
    expect(splitSharedPrefix('500', '500')).toEqual({ prefix: '', rest: '500' })
  })
})

describe('formatBytes', () => {
  const cases: Array<{ name: string; value: number; want: string }> = [
    { name: 'zero', value: 0, want: '0 B' },
    { name: 'plain bytes carry no fraction', value: 512, want: '512 B' },
    { name: 'kibibytes', value: 2048, want: '2.00 KiB' },
    // The retention.bytes from the topic that started this: read as GiB, not GB.
    { name: 'a topic retention limit', value: 250000000000, want: '232.83 GiB' },
    { name: 'terabytes', value: 3 * 1024 ** 4, want: '3.00 TiB' },
    { name: 'not a number', value: Number.NaN, want: '\u2014' },
  ]

  cases.forEach(({ name, value, want }) => {
    it(name, () => {
      expect(formatBytes(value)).toBe(want)
    })
  })
})

describe('formatDurationSeconds', () => {
  const cases: Array<{ name: string; value: number; want: string }> = [
    { name: 'seconds', value: 45, want: '45s' },
    { name: 'minutes', value: 305, want: '5m 5s' },
    { name: 'hours', value: 7500, want: '2h 5m' },
    { name: 'days drop everything below hours', value: 1043400, want: '12d 1h' },
    { name: 'negative is not a duration', value: -1, want: '\u2014' },
  ]

  cases.forEach(({ name, value, want }) => {
    it(name, () => {
      expect(formatDurationSeconds(value)).toBe(want)
    })
  })
})
