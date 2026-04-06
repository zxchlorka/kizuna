export interface SqlStatementRange {
  from: number
  to: number
}

function isIdentifierChar(char: string): boolean {
  return /[A-Za-z0-9_]/.test(char)
}

function readDollarQuoteDelimiter(text: string, start: number): string | null {
  if (text[start] !== '$') {
    return null
  }

  let index = start + 1
  while (index < text.length && text[index] !== '$') {
    if (!isIdentifierChar(text[index])) {
      return null
    }
    index += 1
  }

  if (index >= text.length || text[index] !== '$') {
    return null
  }

  return text.slice(start, index + 1)
}

function scanSqlText(text: string, end: number, onStatementEnd?: (index: number) => void): void {
  let inSingleQuote = false
  let inDoubleQuote = false
  let inLineComment = false
  let blockCommentDepth = 0
  let dollarQuoteDelimiter: string | null = null

  for (let index = 0; index < end; index += 1) {
    const char = text[index]
    const next = text[index + 1]

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false
      }
      continue
    }

    if (blockCommentDepth > 0) {
      if (char === '/' && next === '*') {
        blockCommentDepth += 1
        index += 1
        continue
      }
      if (char === '*' && next === '/') {
        blockCommentDepth -= 1
        index += 1
      }
      continue
    }

    if (dollarQuoteDelimiter) {
      if (text.startsWith(dollarQuoteDelimiter, index)) {
        index += dollarQuoteDelimiter.length - 1
        dollarQuoteDelimiter = null
      }
      continue
    }

    if (inSingleQuote) {
      if (char === "'") {
        if (next === "'") {
          index += 1
        } else {
          inSingleQuote = false
        }
      }
      continue
    }

    if (inDoubleQuote) {
      if (char === '"') {
        if (next === '"') {
          index += 1
        } else {
          inDoubleQuote = false
        }
      }
      continue
    }

    if (char === '-' && next === '-') {
      inLineComment = true
      index += 1
      continue
    }

    if (char === '/' && next === '*') {
      blockCommentDepth = 1
      index += 1
      continue
    }

    if (char === "'") {
      inSingleQuote = true
      continue
    }

    if (char === '"') {
      inDoubleQuote = true
      continue
    }

    if (char === '$') {
      const delimiter = readDollarQuoteDelimiter(text, index)
      if (delimiter) {
        dollarQuoteDelimiter = delimiter
        index += delimiter.length - 1
        continue
      }
    }

    if (char === ';') {
      onStatementEnd?.(index)
    }
  }
}

export function getSqlStatementRanges(text: string): SqlStatementRange[] {
  const ranges: SqlStatementRange[] = []
  let start = 0

  scanSqlText(text, text.length, (index) => {
    if (text.slice(start, index + 1).trim()) {
      ranges.push({ from: start, to: index + 1 })
    }
    start = index + 1
  })

  if (text.slice(start).trim()) {
    ranges.push({ from: start, to: text.length })
  }

  return ranges
}

export function getSqlStatements(text: string): string[] {
  return getSqlStatementRanges(text)
    .map((range) => text.slice(range.from, range.to).trim())
    .filter(Boolean)
}

export function getSqlStatementAtPosition(text: string, cursor: number): string {
  const ranges = getSqlStatementRanges(text)
  if (ranges.length === 0) {
    return text.trim()
  }

  const clampedCursor = Math.max(0, Math.min(cursor, text.length))
  const target = ranges.find((range) => clampedCursor >= range.from && clampedCursor <= range.to) ?? ranges[ranges.length - 1]
  return text.slice(target.from, target.to).trim()
}

export function getSqlStatementPrefix(text: string, cursor: number): string {
  const clampedCursor = Math.max(0, Math.min(cursor, text.length))
  let start = 0

  scanSqlText(text, clampedCursor, (index) => {
    start = index + 1
  })

  return text.slice(start, clampedCursor)
}
