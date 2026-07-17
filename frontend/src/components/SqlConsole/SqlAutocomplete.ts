import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { getSqlStatementPrefix } from '@/lib/sqlStatements'
import type { CompletionItem } from '@/types/api'

type SqlCompletionContext = 'table' | 'column' | 'function' | 'keyword'

export interface SqlCatalogTable {
  schema: string
  name: string
  type: string
}

interface SqlSourceRef {
  schema?: string
  table: string
  alias: string
  qualifiedName: string
}

interface ParsedCompletionContext {
  context: SqlCompletionContext
  from: number
  prefix: string
  table?: string
  schema?: string
  sources: SqlSourceRef[]
  allowAutomatic: boolean
  /** Cursor is completing a dotted path (alias., schema., schema.table.). */
  qualified: boolean
}

const CLAUSE_RE = /\b(group\s+by|order\s+by|delete\s+from|from|join|update|into|select|where|having|on|set|returning)\b/gi
const DOT_RE = /([a-zA-Z_][\w$]*(?:\.[a-zA-Z_][\w$]*)?)\.([a-zA-Z_][\w$]*)?$/
const SOURCE_ALIAS_STOPWORDS = new Set([
  'ON',
  'WHERE',
  'JOIN',
  'LEFT',
  'RIGHT',
  'INNER',
  'OUTER',
  'FULL',
  'CROSS',
  'NATURAL',
  'GROUP',
  'ORDER',
  'LIMIT',
  'OFFSET',
  'RETURNING',
  'SET',
  'VALUES',
  'FROM',
  'USING',
  'AND',
  'OR',
  'HAVING',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
])

const VALUE_OPERATOR_RE = /(?:=|<>|!=|>=|<=|>|<|\+|-|\*|\/|%|\blike\b|\bilike\b|\bbetween\b|\bin\b|\bis\b|\bnot\s+like\b|\bnot\s+ilike\b|\bnot\s+between\b)\s*$/i
const VALUE_LITERAL_RE = /(?:\b\d+(?:\.\d+)?|\bnull\b|\btrue\b|\bfalse\b|\)|'(?:[^']|'')*'|"(?:[^"]|"")*")\s*$/i

function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--.*$/gm, ' ')
}

function extractSources(statement: string): SqlSourceRef[] {
  const sources: SqlSourceRef[] = []
  const normalized = stripComments(statement)
  const pattern = /\b(?:from|join|update|into|delete\s+from)\s+((?:[a-zA-Z_][\w$]*\.)?[a-zA-Z_][\w$]*)(?:\s+(?:as\s+)?([a-zA-Z_][\w$]*))?/gi

  let match: RegExpExecArray | null
  while ((match = pattern.exec(normalized))) {
    const rawTable = match[1]
    const aliasCandidate = (match[2] ?? '').toUpperCase()
    const alias = aliasCandidate && !SOURCE_ALIAS_STOPWORDS.has(aliasCandidate) ? match[2] ?? '' : ''
    const parts = rawTable.split('.')
    const schema = parts.length === 2 ? parts[0] : undefined
    const table = parts.length === 2 ? parts[1] : parts[0]
    const ref: SqlSourceRef = {
      schema,
      table,
      alias: alias || table,
      qualifiedName: schema ? `${schema}.${table}` : table,
    }
    sources.push(ref)
  }

  return sources
}

function detectClause(statement: string): SqlCompletionContext {
  const normalized = stripComments(statement)
  let lastClause = ''
  let match: RegExpExecArray | null
  CLAUSE_RE.lastIndex = 0
  while ((match = CLAUSE_RE.exec(normalized))) {
    lastClause = match[1].toLowerCase()
  }

  if (lastClause === 'from' || lastClause === 'join' || lastClause === 'update' || lastClause === 'into' || lastClause === 'delete from') {
    return 'table'
  }
  if (lastClause === 'select' || lastClause === 'where' || lastClause === 'having' || lastClause === 'on' || lastClause === 'group by' || lastClause === 'order by' || lastClause === 'set' || lastClause === 'returning') {
    return 'column'
  }
  return 'keyword'
}

function getWordPrefix(text: string): string {
  const match = text.match(/([a-zA-Z_][\w$]*)$/)
  return match?.[1] ?? ''
}

function shouldAllowAutomaticSuggestions(statement: string, clause: SqlCompletionContext, wordPrefix: string): boolean {
  if (wordPrefix.length > 0) {
    return true
  }

  const normalized = stripComments(statement).trimEnd()
  if (normalized === '') {
    return false
  }

  if (clause === 'table') {
    return true
  }

  if (VALUE_OPERATOR_RE.test(normalized) || VALUE_LITERAL_RE.test(normalized)) {
    return false
  }

  return true
}

function resolveCatalogTables(catalog: SqlCatalogTable[], prefix: string): CompletionItem[] {
  const needle = prefix.trim()
  const lowerNeedle = needle.toLowerCase()
  const hasDot = lowerNeedle.includes('.')
  const [schemaPrefix, tablePrefix] = hasDot ? lowerNeedle.split('.', 2) : ['', lowerNeedle]

  return catalog
    .filter((item) => {
      const schema = item.schema.toLowerCase()
      const table = item.name.toLowerCase()
      if (hasDot) {
        return schema.startsWith(schemaPrefix) && table.startsWith(tablePrefix)
      }
      return `${schema}.${table}`.startsWith(lowerNeedle) || table.startsWith(lowerNeedle)
    })
    .map((item) => ({
      label: `${item.schema}.${item.name}`,
      type: 'table' as const,
      detail: item.type.toUpperCase().replace(/^([a-z])/, (_, first: string) => first.toUpperCase()) || 'TABLE',
    }))
}

function dedupe(items: CompletionItem[]): CompletionItem[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = `${item.type}:${item.label}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

function resolveColumnTargets(parsed: ParsedCompletionContext): string[] {
  if (parsed.table) {
    return [parsed.table]
  }

  const targets = parsed.sources.map((source) => source.qualifiedName)
  return Array.from(new Set(targets))
}

function buildFunctionFallback(
  prefix: string,
  requestCompletions: (args: { prefix: string; context: SqlCompletionContext; table?: string }) => Promise<CompletionItem[]>
): Promise<CompletionItem[]> {
  return requestCompletions({ prefix, context: 'function' }).catch(() => [])
}

export function detectSqlCompletionContext(
  doc: string,
  pos: number,
  catalogTables: SqlCatalogTable[] = [],
  catalogSchemas: string[] = []
): ParsedCompletionContext {
  const before = getSqlStatementPrefix(doc, pos)
  const trailingDot = before.match(DOT_RE)
  const clause = detectClause(before)
  const sources = extractSources(before)
  const schemaSet = new Set([...catalogTables.map((item) => item.schema.toLowerCase()), ...catalogSchemas.map((schema) => schema.toLowerCase())])

  if (trailingDot) {
    const qualifier = trailingDot[1]
    const prefix = trailingDot[2] ?? ''
    const qualifierLower = qualifier.toLowerCase()
    const source = sources.find((item) => item.alias.toLowerCase() === qualifierLower || item.qualifiedName.toLowerCase() === qualifierLower)

    if (source) {
      return {
        context: 'column',
        from: pos - prefix.length,
        prefix,
        table: source.qualifiedName,
        sources,
        allowAutomatic: true,
        qualified: true,
      }
    }

    if (qualifier.includes('.')) {
      return {
        context: 'column',
        from: pos - prefix.length,
        prefix,
        table: qualifier,
        sources,
        allowAutomatic: true,
        qualified: true,
      }
    }

    if (schemaSet.has(qualifierLower)) {
      const qualifiedPrefix = `${qualifier}.${prefix}`
      return {
        context: 'table',
        from: pos - qualifiedPrefix.length,
        prefix: qualifiedPrefix,
        schema: qualifier,
        sources,
        allowAutomatic: true,
        qualified: true,
      }
    }

    const tablePrefix = `${qualifier}.${prefix}`.trim()
    return {
      context: clause === 'table' ? 'table' : 'column',
      from: clause === 'table' ? pos - tablePrefix.length : pos - prefix.length,
      prefix: tablePrefix,
      sources,
      allowAutomatic: clause === 'table',
      qualified: true,
    }
  }

  const wordPrefix = getWordPrefix(before)
  const allowAutomatic = shouldAllowAutomaticSuggestions(before, clause, wordPrefix)

  return {
    context: clause,
    from: pos - wordPrefix.length,
    prefix: wordPrefix,
    sources,
    allowAutomatic,
    qualified: false,
  }
}

function toCompletionOptions(items: CompletionItem[]) {
  return items.map((item) => ({
    label: item.label,
    type: item.type,
    detail: item.detail,
    boost: item.type === 'column' ? 2 : item.type === 'table' ? 1 : 0,
  }))
}

export function createSqlCompletionSource(
  requestCompletions: (
    args: { prefix: string; context: SqlCompletionContext; table?: string },
    signal?: AbortSignal
  ) => Promise<CompletionItem[]>,
  getCatalogTables: () => SqlCatalogTable[],
  getCatalogSchemas: () => string[],
  hasSchemaCatalog: () => boolean = () => false
) {
  let activeController: AbortController | null = null

  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const catalogTables = getCatalogTables()
    const catalogSchemas = getCatalogSchemas()
    const parsed = detectSqlCompletionContext(context.state.doc.toString(), context.pos, catalogTables, catalogSchemas)
    const hasPrefix = parsed.prefix.trim().length > 0

    // Dotted paths (alias., schema., schema.table.) are handled by lang-sql's
    // schemaCompletionSource once the full catalog is loaded — it resolves
    // aliases through the syntax tree instead of regexes.
    if (hasSchemaCatalog() && parsed.qualified) {
      return null
    }

    if (!context.explicit && !parsed.allowAutomatic) {
      return null
    }

    if (!context.explicit && !hasPrefix && parsed.context === 'keyword') {
      return null
    }

    activeController?.abort()
    activeController = new AbortController()
    const signal = activeController.signal

    try {
      if (parsed.context === 'table') {
        const localTables = resolveCatalogTables(catalogTables, parsed.prefix)
        const remoteTables =
          localTables.length > 0
            ? []
            : await requestCompletions({ prefix: parsed.prefix, context: 'table' }, signal).catch(() => [])
        const options = dedupe([...localTables, ...remoteTables])

        return {
          from: parsed.from,
          options: toCompletionOptions(options),
          validFor: /^[\w$.]*$/,
        }
      }

      if (parsed.context === 'column') {
        const targets = resolveColumnTargets(parsed).filter((target) => target.length > 0)
        const items = await Promise.all(
          targets.map((table) =>
            requestCompletions({ prefix: parsed.prefix, context: 'column', table }, signal).catch(() => [])
          )
        )
        const options = dedupe(items.flat())

        if (options.length > 0) {
          return {
            from: parsed.from,
            options: toCompletionOptions(options),
            validFor: /^[\w$.]*$/,
          }
        }
      }

      const fallback = await buildFunctionFallback(parsed.prefix, (args) => requestCompletions(args, signal))
      if (fallback.length === 0) {
        return null
      }
      return {
        from: parsed.from,
        options: toCompletionOptions(fallback),
        validFor: /^[\w$.]*$/,
      }
    } catch {
      return null
    }
  }
}
