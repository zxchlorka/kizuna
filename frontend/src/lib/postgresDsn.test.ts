import { describe, expect, it } from 'vitest'
import { describeDsn, looksLikeDsn, parseDsn } from '@/lib/postgresDsn'

describe('parseDsn', () => {
  it('reads a full URI', () => {
    expect(parseDsn('postgres://app:s3cret@db.example.com:6432/analytics')).toEqual({
      host: 'db.example.com',
      port: 6432,
      username: 'app',
      password: 's3cret',
      database: 'analytics',
    })
  })

  it('accepts the postgresql:// spelling', () => {
    expect(parseDsn('postgresql://db.example.com/app')?.database).toBe('app')
  })

  // Passwords routinely contain the characters that delimit a URI, which is the
  // whole reason parsing is delegated to the URL parser rather than a regex.
  it('decodes an escaped password', () => {
    expect(parseDsn('postgres://u:p%40ss%3Aword@host/db')?.password).toBe('p@ss:word')
  })

  it('keeps sslmode from the query string', () => {
    expect(parseDsn('postgres://host/db?sslmode=require')?.sslmode).toBe('require')
  })

  // A DSN with only a host is still worth taking: half a filled form beats a
  // rejected paste.
  it('takes what a partial URI offers', () => {
    expect(parseDsn('postgres://db.internal')).toEqual({ host: 'db.internal' })
  })

  it('reads the keyword/value form', () => {
    expect(parseDsn('host=db.example port=5432 dbname=app user=reader')).toEqual({
      host: 'db.example',
      port: 5432,
      database: 'app',
      username: 'reader',
    })
  })

  it('reads a quoted value containing spaces', () => {
    expect(parseDsn("host=db dbname=app password='two words'")?.password).toBe('two words')
  })

  it('accepts database= as well as dbname=', () => {
    expect(parseDsn('host=db database=app')?.database).toBe('app')
  })

  it('is null for text that is not a DSN', () => {
    expect(parseDsn('just some words')).toBeNull()
    expect(parseDsn('https://example.com/page')).toBeNull()
    expect(parseDsn('')).toBeNull()
  })

  // This runs on every paste; malformed input must return null, never throw.
  it('is null for a broken URI rather than throwing', () => {
    expect(parseDsn('postgres://[::bad')).toBeNull()
  })
})

describe('looksLikeDsn', () => {
  it('does not mistake an ordinary word containing host for a DSN', () => {
    expect(looksLikeDsn('the hostname is unknown')).toBe(false)
  })

  it('recognises a keyword pair mid-string', () => {
    expect(looksLikeDsn('psql "host=db dbname=app"')).toBe(true)
  })
})

describe('describeDsn', () => {
  it('names what was taken, and never echoes the password', () => {
    const summary = describeDsn({ host: 'db', port: 5432, database: 'app', username: 'u', password: 'secret' })
    expect(summary).toBe('host db:5432, database app, user u, password')
    expect(summary).not.toContain('secret')
  })
})
