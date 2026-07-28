import { describe, expect, it } from 'vitest'
import { buildCSV, buildJSON, buildTSV, copySingleCellText, timestampForFilename } from '@/lib/tableExport'

const COLS = [{ name: 'id', type: 'int4' }, { name: 'name', type: 'text' }]

describe('buildTSV / buildCSV / buildJSON — empty and single-row results', () => {
  it('empty result: header only, no rows', () => {
    expect(buildTSV(COLS, [])).toBe('id\tname')
    expect(buildCSV(COLS, [])).toBe('id,name')
    expect(buildJSON(COLS, [])).toBe('[]')
  })

  it('single row round-trips through all three formats', () => {
    const rows = [[1, 'Alice']]
    expect(buildTSV(COLS, rows)).toBe('id\tname\n1\tAlice')
    expect(buildCSV(COLS, rows)).toBe('id,name\r\n1,Alice')
    expect(JSON.parse(buildJSON(COLS, rows))).toEqual([{ id: 1, name: 'Alice' }])
  })

  it('multiple rows', () => {
    const rows = [
      [1, 'Alice'],
      [2, 'Bob'],
    ]
    expect(buildTSV(COLS, rows)).toBe('id\tname\n1\tAlice\n2\tBob')
    expect(buildCSV(COLS, rows)).toBe('id,name\r\n1,Alice\r\n2,Bob')
  })
})

describe('NULL vs empty string', () => {
  const cols = [{ name: 'v', type: 'text' }]

  it('TSV shows NULL as literal text (matching SqlResultCell) and an empty string as an empty field', () => {
    expect(buildTSV(cols, [[null]])).toBe('v\nNULL')
    expect(buildTSV(cols, [['']])).toBe('v\n')
  })

  it('undefined is treated the same as null', () => {
    expect(buildTSV(cols, [[undefined]])).toBe('v\nNULL')
    expect(buildCSV(cols, [[undefined]])).toBe('v\r\n')
  })

  it('JSON keeps a real null and a real empty string distinct (no marker text needed)', () => {
    const parsed = JSON.parse(buildJSON(cols, [[null], ['']])) as Array<{ v: unknown }>
    expect(parsed[0].v).toBeNull()
    expect(parsed[1].v).toBe('')
  })

  it('CSV keeps NULL, an empty string and the literal text "NULL" all distinct', () => {
    // The Postgres COPY / pgAdmin / DBeaver convention: absence means NULL,
    // `""` means a value that is empty, and `NULL` is just text. Without this
    // an exported CSV cannot be re-imported without guessing.
    expect(buildCSV(cols, [[null]])).toBe('v\r\n')
    expect(buildCSV(cols, [['']])).toBe('v\r\n""')
    expect(buildCSV(cols, [['NULL']])).toBe('v\r\nNULL')

    const distinct = new Set([
      buildCSV(cols, [[null]]),
      buildCSV(cols, [['']]),
      buildCSV(cols, [['NULL']]),
    ])
    expect(distinct.size).toBe(3)
  })

  it('TSV cannot separate a NULL from the text "NULL" — accepted, since TSV has no quoting', () => {
    // Intentional and asserted so the limitation is visible here rather than
    // discovered later. CSV above is the format that keeps them apart.
    expect(buildTSV(cols, [['NULL']])).toBe(buildTSV(cols, [[null]]))
  })
})

describe('escaping — CSV', () => {
  const cols = [{ name: 'v', type: 'text' }]

  it('quotes a value containing the delimiter', () => {
    expect(buildCSV(cols, [['a,b']])).toBe('v\r\n"a,b"')
  })

  it('quotes and doubles embedded double quotes', () => {
    expect(buildCSV(cols, [['say "hi"']])).toBe('v\r\n"say ""hi"""')
  })

  it('quotes a value containing a newline and preserves the newline inside the quotes', () => {
    expect(buildCSV(cols, [['line1\nline2']])).toBe('v\r\n"line1\nline2"')
  })

  it('does not quote a plain value', () => {
    expect(buildCSV(cols, [['plain']])).toBe('v\r\nplain')
  })
})

describe('escaping — TSV (tabs and newlines inside values)', () => {
  const cols = [{ name: 'v', type: 'text' }]

  it('flattens an embedded tab to a space so the grid does not gain a column', () => {
    expect(buildTSV(cols, [['a\tb']])).toBe('v\na b')
  })

  it('flattens embedded newlines (LF, CR, CRLF) to a single space so the grid does not gain a row', () => {
    expect(buildTSV(cols, [['a\nb']])).toBe('v\na b')
    expect(buildTSV(cols, [['a\rb']])).toBe('v\na b')
    expect(buildTSV(cols, [['a\r\nb']])).toBe('v\na b')
  })
})

describe('CSV-injection guard', () => {
  it('prefixes a text-column value starting with =, +, -, or @ with a single quote', () => {
    const cols = [{ name: 'v', type: 'text' }]
    expect(buildCSV(cols, [['=cmd|calc']])).toBe("v\r\n'=cmd|calc")
    expect(buildCSV(cols, [['+1234']])).toBe("v\r\n'+1234")
    expect(buildCSV(cols, [['-danger']])).toBe("v\r\n'-danger")
    expect(buildCSV(cols, [['@sum(1)']])).toBe("v\r\n'@sum(1)")
  })

  it('applies the same guard to TSV copy, since pasting TSV into Excel is exactly as exploitable as opening a CSV', () => {
    const cols = [{ name: 'v', type: 'text' }]
    expect(buildTSV(cols, [['=cmd|calc']])).toBe("v\n'=cmd|calc")
  })

  it('does NOT prefix a genuinely numeric column, even though -5 starts with a trigger character', () => {
    const cols = [{ name: 'v', type: 'int4' }]
    expect(buildCSV(cols, [[-5]])).toBe('v\r\n-5')
    expect(buildTSV(cols, [[-5]])).toBe('v\n-5')
  })

  it('treats a column with an unknown/absent type as text-like (the safer default)', () => {
    const cols = [{ name: 'v' }]
    expect(buildCSV(cols, [['=risky']])).toBe("v\r\n'=risky")
  })

  it('leaves an empty value alone (no crash indexing [0] of an empty string)', () => {
    const cols = [{ name: 'v', type: 'text' }]
    // Quoted rather than bare: that is how an empty string stays distinct from
    // a NULL — see the NULL vs empty string tests above.
    expect(buildCSV(cols, [['']])).toBe('v\r\n""')
  })
})

describe('types — jsonb, arrays, bytea-as-base64, timestamps', () => {
  it('jsonb object/array values serialize as compact JSON text in TSV/CSV', () => {
    const cols = [{ name: 'payload', type: 'jsonb' }]
    expect(buildTSV(cols, [[{ a: 1, b: [1, 2] }]])).toBe('payload\n{"a":1,"b":[1,2]}')
    expect(buildCSV(cols, [[{ a: 1 }]])).toBe('payload\r\n"{""a"":1}"')
  })

  it('jsonb values keep their native structure in JSON export', () => {
    const cols = [{ name: 'payload', type: 'jsonb' }]
    const parsed = JSON.parse(buildJSON(cols, [[{ a: 1 }]])) as Array<{ payload: unknown }>
    expect(parsed[0].payload).toEqual({ a: 1 })
  })

  it('a pg array (already a JS array after decoding) serializes the same way as jsonb', () => {
    const cols = [{ name: 'tags', type: '_text' }]
    expect(buildTSV(cols, [[['a', 'b', 'c']]])).toBe('tags\n["a","b","c"]')
  })

  it('bytea (already base64-encoded by the backend) passes through as plain text', () => {
    const cols = [{ name: 'blob', type: 'bytea' }]
    expect(buildTSV(cols, [['aGVsbG8=']])).toBe('blob\naGVsbG8=')
  })

  it('timestamps (already ISO strings from the backend) pass through as plain text', () => {
    const cols = [{ name: 'created_at', type: 'timestamptz' }]
    expect(buildTSV(cols, [['2026-07-28T10:00:00Z']])).toBe('created_at\n2026-07-28T10:00:00Z')
  })
})

describe('copySingleCellText — single-cell copy prioritizes readability, not grid safety', () => {
  it('NULL', () => {
    expect(copySingleCellText(null)).toBe('NULL')
    expect(copySingleCellText(undefined)).toBe('NULL')
  })

  it('pretty-prints objects/arrays (unlike the compact row-format serializers)', () => {
    expect(copySingleCellText({ a: 1 })).toBe(JSON.stringify({ a: 1 }, null, 2))
  })

  it('scalar values pass through as plain text', () => {
    expect(copySingleCellText('hello')).toBe('hello')
    expect(copySingleCellText(42)).toBe('42')
    expect(copySingleCellText(true)).toBe('true')
  })
})

describe('timestampForFilename', () => {
  it('produces a filename-safe, sortable timestamp', () => {
    const stamp = timestampForFilename(new Date(2026, 6, 28, 9, 5, 3))
    expect(stamp).toBe('20260728-090503')
    expect(stamp).not.toMatch(/[/:\\]/)
  })
})

describe('performance — 500 rows must not be slow enough to matter', () => {
  it('serializes 500 rows x 20 columns (with realistic-sized values) in well under a UI-blocking amount of time', () => {
    const cols = Array.from({ length: 20 }, (_, i) => ({ name: `col${i}`, type: i % 3 === 0 ? 'jsonb' : 'text' }))
    const rows = Array.from({ length: 500 }, (_, r) =>
      cols.map((_, c) => (c % 3 === 0 ? { id: r, nested: { c, text: 'x'.repeat(40) } } : `value-${r}-${c}-${'y'.repeat(20)}`))
    )

    const start = performance.now()
    buildTSV(cols, rows)
    buildCSV(cols, rows)
    buildJSON(cols, rows)
    const elapsed = performance.now() - start

    // Generous budget: this is a regression guard (something going quadratic),
    // not a tight perf target. In practice this measures well under 20ms.
    expect(elapsed).toBeLessThan(200)
  })
})
