// Safe arithmetic evaluator + template expansion for the Kafka producer's
// multi-push loop mode. No eval/Function — a small recursive-descent parser
// over a fixed grammar (numbers, the variable `i`, + - * / %, parentheses,
// unary minus).

export const MAX_LOOP_COUNT = 10000

export interface ExpandedMessage {
  key: string
  value: string
  headers: Record<string, string>
}

export interface ExpandResult {
  messages: ExpandedMessage[]
  errors: string[]
}

export type ProduceMode = 'single' | 'multi' | 'loop'

export interface LoopParams {
  start: number
  step: number
  count: number
}

interface Token {
  type: 'number' | 'ident' | 'op' | 'lparen' | 'rparen'
  value: string
}

function tokenize(expr: string): Token[] {
  const tokens: Token[] = []
  let pos = 0

  while (pos < expr.length) {
    const ch = expr[pos]

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      pos += 1
      continue
    }
    if (ch >= '0' && ch <= '9') {
      let num = ''
      while (pos < expr.length && ((expr[pos] >= '0' && expr[pos] <= '9') || expr[pos] === '.')) {
        num += expr[pos]
        pos += 1
      }
      tokens.push({ type: 'number', value: num })
      continue
    }
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') {
      let ident = ''
      while (pos < expr.length && /[a-zA-Z0-9_]/.test(expr[pos])) {
        ident += expr[pos]
        pos += 1
      }
      tokens.push({ type: 'ident', value: ident })
      continue
    }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '%') {
      tokens.push({ type: 'op', value: ch })
      pos += 1
      continue
    }
    if (ch === '(') {
      tokens.push({ type: 'lparen', value: ch })
      pos += 1
      continue
    }
    if (ch === ')') {
      tokens.push({ type: 'rparen', value: ch })
      pos += 1
      continue
    }
    throw new Error(`Unexpected character "${ch}"`)
  }

  return tokens
}

// Grammar:
//   expr   = term (('+' | '-') term)*
//   term   = factor (('*' | '/' | '%') factor)*
//   factor = '-' factor | number | ident | '(' expr ')'
function parseAndEval(tokens: Token[], i: number): number {
  let pos = 0

  const peek = () => tokens[pos]

  function expr(): number {
    let left = term()
    while (peek() && peek().type === 'op' && (peek().value === '+' || peek().value === '-')) {
      const op = tokens[pos].value
      pos += 1
      const right = term()
      left = op === '+' ? left + right : left - right
    }
    return left
  }

  function term(): number {
    let left = factor()
    while (peek() && peek().type === 'op' && (peek().value === '*' || peek().value === '/' || peek().value === '%')) {
      const op = tokens[pos].value
      pos += 1
      const right = factor()
      if (op === '*') {
        left *= right
      } else if (op === '/') {
        left /= right
      } else {
        left %= right
      }
    }
    return left
  }

  function factor(): number {
    const token = peek()
    if (!token) {
      throw new Error('Unexpected end of expression')
    }
    if (token.type === 'op' && token.value === '-') {
      pos += 1
      return -factor()
    }
    if (token.type === 'op' && token.value === '+') {
      pos += 1
      return factor()
    }
    if (token.type === 'number') {
      pos += 1
      return Number.parseFloat(token.value)
    }
    if (token.type === 'ident') {
      pos += 1
      if (token.value === 'i') {
        return i
      }
      throw new Error(`Unknown variable "${token.value}"`)
    }
    if (token.type === 'lparen') {
      pos += 1
      const value = expr()
      if (!peek() || peek().type !== 'rparen') {
        throw new Error('Missing closing parenthesis')
      }
      pos += 1
      return value
    }
    throw new Error(`Unexpected token "${token.value}"`)
  }

  const result = expr()
  if (pos !== tokens.length) {
    throw new Error('Unexpected trailing input in expression')
  }
  return result
}

export function evalExpr(expression: string, i: number): number {
  const tokens = tokenize(expression)
  if (tokens.length === 0) {
    throw new Error('Empty expression')
  }
  const result = parseAndEval(tokens, i)
  if (!Number.isFinite(result)) {
    throw new Error('Expression did not evaluate to a finite number')
  }
  return result
}

// Replaces every {{ expression }} with its evaluated numeric value. JS String()
// already renders integers without a trailing ".0" and floats verbatim.
export function expandTemplate(template: string, i: number): string {
  return template.replace(/\{\{([^}]*)\}\}/g, (_match, raw: string) => {
    const expression = raw.trim()
    if (expression === '') {
      throw new Error('Empty {{ }} placeholder')
    }
    return String(evalExpr(expression, i))
  })
}

function expandHeaders(headers: Array<{ key: string; value: string }>, i: number | null): Record<string, string> {
  const result: Record<string, string> = {}
  for (const header of headers) {
    const name = header.key.trim()
    if (name === '') {
      continue
    }
    result[name] = i === null ? header.value : expandTemplate(header.value, i)
  }
  return result
}

export interface ExpandInputs {
  mode: ProduceMode
  value: string
  key: string
  headers: Array<{ key: string; value: string }>
  loop: LoopParams
}

// Builds the message batch for the chosen mode, validating that every value is
// valid JSON. Returns collected errors instead of throwing so the modal can
// surface them inline.
export function expandMessages(inputs: ExpandInputs): ExpandResult {
  const errors: string[] = []
  const messages: ExpandedMessage[] = []

  const pushValidated = (key: string, value: string, headers: Record<string, string>, label: string) => {
    try {
      JSON.parse(value)
    } catch (error) {
      errors.push(`${label}: invalid JSON — ${(error as Error).message}`)
      return
    }
    messages.push({ key, value, headers })
  }

  if (inputs.mode === 'single') {
    pushValidated(inputs.key, inputs.value, expandHeaders(inputs.headers, null), 'Message')
    return { messages, errors }
  }

  if (inputs.mode === 'multi') {
    let parsed: unknown
    try {
      parsed = JSON.parse(`[${inputs.value}]`)
    } catch (error) {
      return { messages: [], errors: [`Could not parse comma-separated JSON — ${(error as Error).message}`] }
    }
    if (!Array.isArray(parsed)) {
      return { messages: [], errors: ['Expected a comma-separated list of JSON objects'] }
    }
    const sharedHeaders = expandHeaders(inputs.headers, null)
    for (const item of parsed) {
      messages.push({ key: inputs.key, value: JSON.stringify(item), headers: sharedHeaders })
    }
    return { messages, errors }
  }

  // loop
  const { start, step, count } = inputs.loop
  if (!Number.isFinite(count) || count <= 0) {
    return { messages: [], errors: ['Count must be a positive number'] }
  }
  if (count > MAX_LOOP_COUNT) {
    return { messages: [], errors: [`Count exceeds the limit of ${MAX_LOOP_COUNT}`] }
  }

  for (let n = 0; n < count; n += 1) {
    const i = start + n * step
    try {
      const value = expandTemplate(inputs.value, i)
      const key = inputs.key === '' ? '' : expandTemplate(inputs.key, i)
      pushValidated(key, value, expandHeaders(inputs.headers, i), `i=${i}`)
    } catch (error) {
      errors.push(`i=${i}: ${(error as Error).message}`)
    }
  }

  return { messages, errors }
}
