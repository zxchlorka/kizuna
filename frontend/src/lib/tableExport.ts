import { getPostgresTypeCategory } from '@/lib/postgresTypes'

/**
 * Shared copy/export serializers for table-shaped results (SQL console
 * results, PostgreSQL table view). Deliberately format-agnostic about the
 * source: callers pass column names/types plus rows as parallel arrays, so
 * the same code serializes an ExecResult (rows already are unknown[][]) and a
 * PgTableView row (Record<string, unknown>, converted to an array by the
 * caller) without duplicating the format logic per surface.
 *
 * ## NULL vs empty string
 *
 * These are different values and losing the distinction makes the export lie.
 * Each format draws the line the way its own consumers expect:
 *
 * - JSON gets a real `null` and a real `""`. Unambiguous, nothing to decide.
 * - CSV follows the convention every other database tool uses (Postgres COPY,
 *   pgAdmin, DBeaver): NULL is an empty *unquoted* field, an empty string is a
 *   quoted `""`. That keeps all three of NULL, `""` and the literal text
 *   `NULL` distinct, so a CSV written here can be re-imported without guessing.
 * - TSV renders NULL as the literal text `NULL`, matching how SqlResultCell
 *   draws it on screen. TSV has no quoting, so it genuinely cannot separate
 *   that from a text value whose content is `NULL` — an accepted loss for a
 *   format that already flattens tabs and newlines (see tsvFieldText). TSV is
 *   the paste-into-a-spreadsheet format, where readability wins; CSV is the
 *   round-tripping one.
 *
 * ## jsonb / arrays / bytea / timestamps
 *
 * By the time a value reaches the frontend it has already been decoded into
 * its natural JS shape by the backend's JSON response (jsonb -> object/array,
 * pg array -> JS array, bytea -> base64 string, timestamp -> ISO string) —
 * there is nothing PG-specific left to special-case here. Object/array
 * values are rendered as COMPACT JSON (no indentation): SqlResultCell uses
 * pretty-printed JSON for on-screen display, but TSV/CSV are one-line-per-row
 * grid formats, so a multi-line pretty value would corrupt the grid when
 * pasted into a spreadsheet. Structure-preserving copies of a single complex
 * value are what "Copy cell" is for (see copySingleCellText below), not the
 * grid formats.
 */

export interface ExportColumn {
  name: string
  /** Postgres type name, e.g. "jsonb", "int4", "timestamptz". Optional because
   * not every caller has it (e.g. an ad hoc single value) — treated as
   * "unknown" (text-like) when absent, which is the safer default for the
   * CSV-injection guard below. */
  type?: string
}

const NULL_TEXT = 'NULL'

/** The base textual form of a value, before any format-specific escaping. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) {
    return NULL_TEXT
  }
  if (typeof value === 'object') {
    // Arrays and jsonb objects. Compact on purpose — see the module comment.
    return JSON.stringify(value)
  }
  return String(value)
}

// OWASP CSV-injection guidance: a field opened by a spreadsheet app that
// starts with one of these characters can be interpreted as a formula (or, for
// `+`/`-`/`@`, a formula-launching prefix in some Excel versions) rather than
// literal text. The standard mitigation is to prefix such a field with a
// single quote, which forces spreadsheet apps to treat it as text.
//
// This only matters for values that came from arbitrary/attacker-influenced
// TEXT data — a value from a genuinely numeric column can't contain a
// formula string, and prefixing e.g. a legitimate `-5` would corrupt real
// data for no security benefit. So the guard only applies when the column's
// type is not classified as numeric (unknown/absent type counts as
// "not numeric", the safer default).
const FORMULA_TRIGGER_CHARS = new Set(['=', '+', '-', '@'])

function neutralizeFormulaInjection(text: string, columnType: string | undefined): string {
  if (text.length === 0) {
    return text
  }
  if (columnType && getPostgresTypeCategory(columnType) === 'numeric') {
    return text
  }
  return FORMULA_TRIGGER_CHARS.has(text[0]) ? `'${text}` : text
}

// TSV has no standard quoting/escaping mechanism that spreadsheet paste
// honors, unlike CSV's RFC4180 quoting. A literal tab or newline inside a
// value would silently misalign the grid (an extra column, or an extra row)
// when pasted — worse than losing the original whitespace, since misaligned
// data can be silently wrong in a way that's not obviously an artifact.
// Both are flattened to a single space.
function tsvFieldText(value: unknown, columnType: string | undefined): string {
  const text = cellText(value).replace(/\r\n|\r|\n/g, ' ').replace(/\t/g, ' ')
  return neutralizeFormulaInjection(text, columnType)
}

function csvFieldText(value: unknown, columnType: string | undefined): string {
  // NULL is the one value CSV represents by absence rather than by content —
  // see the module comment. Returning early keeps it from being quoted below,
  // which is exactly what separates it from an empty string.
  if (value === null || value === undefined) {
    return ''
  }
  const text = neutralizeFormulaInjection(cellText(value), columnType)
  // An empty string is quoted so it reads as "a value that happens to be
  // empty" rather than "no value", which is what the bare field above means.
  if (text.length === 0) {
    return '""'
  }
  // RFC4180: quote only when necessary (delimiter, quote, or newline present),
  // doubling embedded quotes. Real newlines inside a quoted CSV field are
  // valid and round-trip correctly in Excel/Sheets/Postgres COPY, so — unlike
  // TSV — there's no need to flatten them.
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

export function buildTSV(columns: ExportColumn[], rows: unknown[][]): string {
  const header = columns.map((c) => c.name).join('\t')
  const body = rows.map((row) => columns.map((col, i) => tsvFieldText(row[i], col.type)).join('\t'))
  return [header, ...body].join('\n')
}

export function buildCSV(columns: ExportColumn[], rows: unknown[][]): string {
  const header = columns.map((c) => csvFieldText(c.name, undefined)).join(',')
  const body = rows.map((row) => columns.map((col, i) => csvFieldText(row[i], col.type)).join(','))
  // RFC4180 specifies CRLF line endings.
  return [header, ...body].join('\r\n')
}

export function buildJSON(columns: ExportColumn[], rows: unknown[][]): string {
  const objects = rows.map((row) => {
    const obj: Record<string, unknown> = {}
    columns.forEach((col, i) => {
      // Native JSON has a real null and a real empty string — no marker text
      // needed here, unlike TSV/CSV.
      obj[col.name] = row[i] === undefined ? null : row[i]
    })
    return obj
  })
  return JSON.stringify(objects, null, 2)
}

/** Copy target for a single cell: prioritizes readability over grid-safety
 * (there's no grid to misalign), so unlike the TSV/CSV row formats above,
 * object/array values are pretty-printed, matching how SqlResultCell and
 * LargeValueModal already display them. */
export function copySingleCellText(value: unknown): string {
  if (value === null || value === undefined) {
    return NULL_TEXT
  }
  if (typeof value === 'object') {
    return JSON.stringify(value, null, 2)
  }
  return String(value)
}

export function downloadTextFile(filename: string, mimeType: string, content: string): void {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  try {
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  } finally {
    // Revoke on a delay: some browsers cancel the download if the object URL
    // is revoked synchronously before the click has been processed.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}

/** yyyy-mm-dd-HHMMSS, safe to drop straight into a filename. */
export function timestampForFilename(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}
