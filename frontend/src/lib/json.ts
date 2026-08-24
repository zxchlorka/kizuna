// Kizuna's whole job is showing the value that is actually stored. JSON.parse
// maps every JSON number onto a double, so an integer above 2^53 comes back
// rounded: the snowflake id 2091885016401416192 reads as 2091885016401416200.
// That is not a display glitch — it is a different record. An id copied out of
// the UI finds no key, and a pretty-print that round-trips through Number
// writes the rounded number back on save.
//
// Ids of that size are ordinary here: Postgres bigserial/bigint, snowflake ids
// in Redis values and Kafka payloads. So nothing in this module ever puts a
// value through Number — text in, text out.

// Fast path: a double holds ~17 significant decimal digits, so a payload with
// no long digit-or-point run has nothing that could have been rounded and needs
// no rewriting at all.
const RISKY_NUMBER = /\d[\d.]{16,}/

const NUMBER_CHARS = /[-+.eE0-9]/

const NUMBER_LITERAL = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/

function isWhitespace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r'
}

// Index just past the JSON string literal whose opening quote sits at `open`.
// Escapes are skipped as a pair so a \" does not end the literal early.
function endOfString(text: string, open: number): number {
  let i = open + 1
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2
      continue
    }
    if (text[i] === '"') {
      return i + 1
    }
    i++
  }
  return i
}

// The exact value of a number literal, as sign + significand digits + a
// power-of-ten exponent, with formatting removed: "1.0", "1", "0.10e1" and
// "1e0" all reduce to the same triple. Comparing triples answers "is this the
// same number", where comparing text would only answer "is this the same
// spelling" — and a spelling difference such as 1.0 vs 1 loses nothing.
function decimalValue(token: string): { sign: string; digits: string; exp: number } | null {
  const match = NUMBER_LITERAL.exec(token)
  if (!match) {
    return null
  }
  const [, sign, intPart, fracPart = '', expPart] = match

  let digits = intPart + fracPart
  let exp = (expPart ? Number(expPart) : 0) - fracPart.length

  digits = digits.replace(/^0+/, '')
  const withoutTrailingZeros = digits.replace(/0+$/, '')
  exp += digits.length - withoutTrailingZeros.length
  digits = withoutTrailingZeros

  // Zero has one spelling here, so -0, 0.0 and 0e5 all compare equal.
  if (digits === '') {
    return { sign: '', digits: '0', exp: 0 }
  }
  return { sign: sign === '-' ? '-' : '', digits, exp }
}

/**
 * Whether a JSON number literal denotes a value a double cannot hold — an int64
 * id past 2^53, or a decimal with more significant digits than a double keeps
 * (a numeric(30,2) amount). Values that merely *spell* differently after a
 * round-trip, like `1.0`, are not lossy and stay plain numbers.
 */
export function isLossyNumber(token: string): boolean {
  const literal = decimalValue(token)
  if (literal === null) {
    return false
  }
  const roundTripped = decimalValue(String(Number(token)))
  if (roundTripped === null) {
    // Number() reached Infinity or NaN — the value is gone entirely.
    return true
  }
  return (
    literal.sign !== roundTripped.sign ||
    literal.digits !== roundTripped.digits ||
    literal.exp !== roundTripped.exp
  )
}

/**
 * The same JSON text with every precision-losing number literal wrapped in
 * quotes, so JSON.parse hands back the exact digits as a string instead of a
 * rounded number. Everything else — strings, numbers a double holds exactly,
 * structure, whitespace — is copied byte for byte.
 */
export function quoteInexactNumbers(text: string): string {
  if (!RISKY_NUMBER.test(text)) {
    return text
  }

  let out = ''
  let copied = 0
  let i = 0
  while (i < text.length) {
    if (text[i] === '"') {
      i = endOfString(text, i)
      continue
    }
    if (!NUMBER_CHARS.test(text[i])) {
      i++
      continue
    }
    // A run of number characters. Outside a string literal, valid JSON only
    // grows these inside a number — the stray `e` of `true`/`false` scans as a
    // one-character run and is not a number literal, so it falls through
    // harmlessly.
    const start = i
    while (i < text.length && NUMBER_CHARS.test(text[i])) i++
    const token = text.slice(start, i)
    if (isLossyNumber(token)) {
      out += text.slice(copied, start) + '"' + token + '"'
      copied = i
    }
  }

  return copied === 0 ? text : out + text.slice(copied)
}

/**
 * JSON.parse that keeps int64 and high-precision decimal values intact: a
 * number a double cannot hold arrives as a string of its exact digits. Throws
 * on invalid JSON, like JSON.parse.
 */
export function parseJsonLossless(text: string): unknown {
  return JSON.parse(quoteInexactNumbers(text))
}

/**
 * Re-indents JSON *as text*. Literals are copied character for character, so a
 * large integer survives the pretty-print — unlike the obvious
 * `JSON.stringify(JSON.parse(x), null, 2)`, which rounds it on the way through
 * and, in an editor, saves the rounded value back.
 *
 * Output matches JSON.stringify's layout at the same indent. Returns null when
 * the text is not valid JSON.
 */
export function formatJson(text: string, indent = 2): string | null {
  try {
    // Validation only. The output below is built from the text, never from the
    // parsed value.
    JSON.parse(text)
  } catch {
    return null
  }

  const step = ' '.repeat(indent)
  let out = ''
  let depth = 0
  let i = 0
  const newline = () => {
    out += '\n' + step.repeat(depth)
  }

  while (i < text.length) {
    const c = text[i]
    if (c === '"') {
      const end = endOfString(text, i)
      out += text.slice(i, end)
      i = end
      continue
    }

    i++
    if (isWhitespace(c)) {
      continue
    }
    if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']'
      let j = i
      while (j < text.length && isWhitespace(text[j])) j++
      if (text[j] === close) {
        // JSON.stringify keeps an empty container on one line.
        out += c + close
        i = j + 1
        continue
      }
      out += c
      depth++
      newline()
      continue
    }
    if (c === '}' || c === ']') {
      depth--
      newline()
      out += c
      continue
    }
    if (c === ',') {
      out += ','
      newline()
      continue
    }
    if (c === ':') {
      out += ': '
      continue
    }
    // One character of a number, true, false or null.
    out += c
  }

  return out
}
