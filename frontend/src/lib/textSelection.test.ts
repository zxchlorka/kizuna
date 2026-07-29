import { describe, expect, it } from 'vitest'
import { tokenAt, trimToken } from '@/lib/textSelection'

const COOKIES = '019da7fb-c534-7daf-b477-534a07d9f8fe,019da7fe-55f0-7aa4-8e18-ba90a7e84f08'

describe('tokenAt', () => {
  it('takes the first comma-separated element', () => {
    expect(tokenAt(COOKIES, 5)).toBe('019da7fb-c534-7daf-b477-534a07d9f8fe')
  })

  it('takes the second element when the offset is inside it', () => {
    expect(tokenAt(COOKIES, 45)).toBe('019da7fe-55f0-7aa4-8e18-ba90a7e84f08')
  })

  it('keeps a value that contains colons and dashes intact', () => {
    expect(tokenAt('profile:123,profile:124', 3)).toBe('profile:123')
  })

  it('splits on semicolons', () => {
    expect(tokenAt('a-1;b-2;c-3', 5)).toBe('b-2')
  })

  it('splits on slashes', () => {
    expect(tokenAt('a-1/b-2', 5)).toBe('b-2')
  })

  it('splits on spaces', () => {
    expect(tokenAt('a-1 b-2', 5)).toBe('b-2')
  })

  it('splits a JSON array into bare elements', () => {
    expect(tokenAt('["a-1","b-2"]', 3)).toBe('a-1')
  })

  it('handles an offset at the very start', () => {
    expect(tokenAt('a-1,b-2', 0)).toBe('a-1')
  })

  it('handles an offset at the very end', () => {
    expect(tokenAt('a-1,b-2', 7)).toBe('b-2')
  })

  it('returns the left token when the offset sits on a separator', () => {
    expect(tokenAt('a-1,b-2', 3)).toBe('a-1')
  })

  it('returns an empty string for text made only of separators', () => {
    expect(tokenAt(',, ,', 2)).toBe('')
  })

  it('returns an empty string for an out-of-range offset', () => {
    expect(tokenAt('a-1', 9)).toBe('')
    expect(tokenAt('a-1', -1)).toBe('')
  })
})

describe('trimToken', () => {
  it('strips quotes, commas and spaces around a selection', () => {
    expect(trimToken(' "abc-1", ')).toBe('abc-1')
  })

  it('keeps an already clean value untouched', () => {
    expect(trimToken('profile:123')).toBe('profile:123')
  })

  it('returns an empty string when everything is a separator', () => {
    expect(trimToken(' ,,, ')).toBe('')
  })

  it('does not strip inner separators', () => {
    expect(trimToken('"a-1,b-2"')).toBe('a-1,b-2')
  })
})
