// What a pasted Postgres connection string yields. Every field is optional: a
// DSN may carry only a host, and half-filling the form beats rejecting a paste
// because it lacked a database name.
export interface ParsedDsn {
  host?: string
  port?: number
  database?: string
  username?: string
  password?: string
  sslmode?: string
}

// A DSN arrives from wherever the user had it — a wiki, a terminal, a colleague's
// message — so it is recognised in both shapes Postgres itself accepts.
const URI_SCHEMES = ['postgres://', 'postgresql://']

export function looksLikeDsn(text: string): boolean {
  const value = text.trim()
  if (URI_SCHEMES.some((scheme) => value.toLowerCase().startsWith(scheme))) {
    return true
  }
  // keyword/value form: host=db.example port=5432 dbname=app
  return /(^|\s)(host|dbname|user|password|port)\s*=/.test(value)
}

// parseDsn returns what it could read, or null when the text is not a DSN at all.
// It never throws: this runs on every paste into a text field, and a paste that
// happens to look like a URL must not break typing.
export function parseDsn(text: string): ParsedDsn | null {
  const value = text.trim()
  if (!looksLikeDsn(value)) {
    return null
  }
  return URI_SCHEMES.some((scheme) => value.toLowerCase().startsWith(scheme))
    ? parseUri(value)
    : parseKeywordValue(value)
}

function parseUri(value: string): ParsedDsn | null {
  let url: URL
  try {
    // The URL parser does not know the postgres scheme's defaults, but it does
    // know how to split authority from path and to percent-decode credentials —
    // which is the part worth not writing by hand, since passwords routinely
    // contain @ and :.
    url = new URL(value)
  } catch {
    return null
  }

  const parsed: ParsedDsn = {}
  if (url.hostname) parsed.host = decodeURIComponent(url.hostname)
  if (url.port) parsed.port = Number(url.port)
  if (url.username) parsed.username = decodeURIComponent(url.username)
  if (url.password) parsed.password = decodeURIComponent(url.password)

  // A leading slash always, and possibly nothing after it.
  const database = url.pathname.replace(/^\//, '')
  if (database) parsed.database = decodeURIComponent(database)

  const sslmode = url.searchParams.get('sslmode')
  if (sslmode) parsed.sslmode = sslmode

  return parsed
}

function parseKeywordValue(value: string): ParsedDsn | null {
  const parsed: ParsedDsn = {}
  // Values may be single-quoted to carry spaces: password='a b c'
  const pairs = value.matchAll(/(\w+)\s*=\s*(?:'([^']*)'|(\S+))/g)

  for (const [, rawKey, quoted, bare] of pairs) {
    const key = rawKey.toLowerCase()
    const item = quoted ?? bare ?? ''
    switch (key) {
      case 'host':
        parsed.host = item
        break
      case 'port':
        parsed.port = Number(item)
        break
      case 'dbname':
      case 'database':
        parsed.database = item
        break
      case 'user':
        parsed.username = item
        break
      case 'password':
        parsed.password = item
        break
      case 'sslmode':
        parsed.sslmode = item
        break
    }
  }

  return Object.keys(parsed).length > 0 ? parsed : null
}

// describeDsn names what was filled in, so the form can say what it took rather
// than silently rewriting fields the user was looking at.
export function describeDsn(parsed: ParsedDsn): string {
  const parts: string[] = []
  if (parsed.host) parts.push(`host ${parsed.host}${parsed.port ? `:${parsed.port}` : ''}`)
  if (parsed.database) parts.push(`database ${parsed.database}`)
  if (parsed.username) parts.push(`user ${parsed.username}`)
  if (parsed.password) parts.push('password')
  return parts.join(', ')
}
