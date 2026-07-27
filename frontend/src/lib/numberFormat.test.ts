import { describe, expect, it } from 'vitest'
import { formatCompactCount, formatExactCount, splitSharedPrefix } from '@/lib/numberFormat'

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
