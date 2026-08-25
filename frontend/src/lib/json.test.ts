import { describe, expect, it } from 'vitest'
import { formatJson, isLossyNumber, parseJsonLossless, quoteInexactNumbers } from '@/lib/json'

// The value that started this: a snowflake profile id stored in Redis. Plain
// JSON.parse reads it back as …200, which is a key that does not exist.
const SNOWFLAKE = '2091885016401416192'

describe('isLossyNumber', () => {
  it('flags integers a double cannot hold', () => {
    expect(isLossyNumber(SNOWFLAKE)).toBe(true)
    expect(isLossyNumber('-' + SNOWFLAKE)).toBe(true)
    expect(isLossyNumber('9007199254740993')).toBe(true)
  })

  it('leaves values a double holds exactly alone, however they are spelled', () => {
    expect(isLossyNumber('0')).toBe(false)
    expect(isLossyNumber('-0')).toBe(false)
    expect(isLossyNumber('770006')).toBe(false)
    expect(isLossyNumber('9007199254740991')).toBe(false)
    expect(isLossyNumber('1.0')).toBe(false)
    expect(isLossyNumber('1.50')).toBe(false)
    expect(isLossyNumber('0.1')).toBe(false)
    expect(isLossyNumber('1e300')).toBe(false)
    expect(isLossyNumber('0.10e1')).toBe(false)
  })

  it('flags decimals with more digits than a double keeps', () => {
    // A numeric(30,2) amount out of Postgres.
    expect(isLossyNumber('123456789012345678.99')).toBe(true)
    // Significant digits split across the point still exceed the budget.
    expect(isLossyNumber('12345678.901234567890123')).toBe(true)
    expect(isLossyNumber('1e400')).toBe(true)
  })
})

describe('quoteInexactNumbers', () => {
  it('quotes a bare oversized integer', () => {
    expect(quoteInexactNumbers(SNOWFLAKE)).toBe(`"${SNOWFLAKE}"`)
  })

  it('leaves payloads without long digit runs untouched', () => {
    const text = '{"a":1,"b":[true,false,null],"c":"x"}'
    expect(quoteInexactNumbers(text)).toBe(text)
  })

  it('never rewrites digits inside strings, including escaped quotes', () => {
    const text = `{"note":"id ${SNOWFLAKE} \\" ${SNOWFLAKE}","id":${SNOWFLAKE}}`
    expect(quoteInexactNumbers(text)).toBe(
      `{"note":"id ${SNOWFLAKE} \\" ${SNOWFLAKE}","id":"${SNOWFLAKE}"}`
    )
  })

  it('handles several ids and keeps small numbers numeric', () => {
    const parsed = parseJsonLossless(
      `{"ids":[${SNOWFLAKE},1,${SNOWFLAKE}],"n":7,"f":1.5}`
    ) as { ids: unknown[]; n: unknown; f: unknown }
    expect(parsed.ids).toEqual([SNOWFLAKE, 1, SNOWFLAKE])
    expect(parsed.n).toBe(7)
    expect(parsed.f).toBe(1.5)
  })

  it('is not confused by the trailing e of true/false', () => {
    expect(parseJsonLossless(`[true,false,${SNOWFLAKE}]`)).toEqual([true, false, SNOWFLAKE])
  })

  it('keeps a high-precision decimal, and only that one', () => {
    expect(parseJsonLossless('{"amount":123456789012345678.99,"rate":1.5}')).toEqual({
      amount: '123456789012345678.99',
      rate: 1.5,
    })
  })
})

describe('formatJson', () => {
  it('pretty-prints without touching the digits', () => {
    expect(formatJson(`{"profile_id":${SNOWFLAKE},"n":1}`)).toBe(
      `{\n  "profile_id": ${SNOWFLAKE},\n  "n": 1\n}`
    )
  })

  it('matches JSON.stringify layout for values that survive it', () => {
    const value = { a: 1, b: [1, 2], c: {}, d: [], e: { f: 'x: y' }, g: null }
    const text = JSON.stringify(value)
    expect(formatJson(text)).toBe(JSON.stringify(value, null, 2))
  })

  it('is idempotent and keeps string contents verbatim', () => {
    const text = `{"s":"a,b:{ }","id":${SNOWFLAKE}}`
    const once = formatJson(text)
    expect(once).not.toBeNull()
    expect(formatJson(once as string)).toBe(once)
    expect(JSON.parse(once as string).s).toBe('a,b:{ }')
  })

  it('returns a bare scalar unchanged', () => {
    expect(formatJson(SNOWFLAKE)).toBe(SNOWFLAKE)
  })

  it('returns null for text that is not JSON', () => {
    expect(formatJson('not json')).toBeNull()
    expect(formatJson('')).toBeNull()
  })
})
