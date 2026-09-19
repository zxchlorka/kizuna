import { describe, expect, it } from 'vitest'
import { compareDocuments, documentFields, splitValues, type CompareDocument } from '@/lib/redisCompare'

const profile = (key: string, fields: Record<string, string>): CompareDocument => ({
  key,
  type: 'hash',
  value: fields,
})

describe('splitValues', () => {
  // mapper.go writes ids as strings.Join(values, ","), so a field is a list.
  it('splits a joined list', () => {
    expect(splitValues('019ec4d4, 71b0aa2f,9f3c1d88')).toEqual(['019ec4d4', '71b0aa2f', '9f3c1d88'])
  })

  it('treats a plain value as a list of one', () => {
    expect(splitValues('1787579358')).toEqual(['1787579358'])
  })

  it('drops empties, which is what an unset field looks like', () => {
    expect(splitValues('')).toEqual([])
    expect(splitValues(' , ')).toEqual([])
  })
})

describe('compareDocuments finds what keys share', () => {
  // The case from the investigation: two profiles that carry the same install
  // id, which by the merge usecase means they should have merged into one.
  const docs = [
    profile('profile:2091885016401416192', {
      install_ids: '019ff59b-ddad-7226-971a-000000000004',
      gaid_ids: 'manual-c6-gaid',
      wb_user_id: '770006',
      cookie_ids: '',
    }),
    profile('profile:2091885444434333696', {
      install_ids: '019ff59b-ddad-7226-971a-000000000005',
      idfa_ids: 'manual-c6-idfa',
      cookie_ids: '',
    }),
    profile('profile:2093263633890222080', {
      install_ids: '019ff59b-ddad-7226-971a-000000000004',
      cookie_ids: '',
    }),
  ]

  it('names the shared value and who holds it', () => {
    const { sharedValues } = compareDocuments(docs)
    expect(sharedValues).toEqual([
      {
        field: 'install_ids',
        value: '019ff59b-ddad-7226-971a-000000000004',
        keys: ['profile:2091885016401416192', 'profile:2093263633890222080'],
      },
    ])
  })

  it('marks the shared cells and leaves the unique ones alone', () => {
    const row = compareDocuments(docs).rows.find((r) => r.field === 'install_ids')
    expect(row?.hasShared).toBe(true)
    expect(row?.cells[0][0].shared).toBe(true)
    expect(row?.cells[1][0].shared).toBe(false)
    expect(row?.cells[2][0].shared).toBe(true)
  })

  it('keeps a field only one key has', () => {
    const row = compareDocuments(docs).rows.find((r) => r.field === 'gaid_ids')
    expect(row?.hasShared).toBe(false)
    expect(row?.cells[0][0].text).toBe('manual-c6-gaid')
    expect(row?.cells[1]).toEqual([])
  })

  it('flags a field no key carries, so the view can hide the noise', () => {
    const row = compareDocuments(docs).rows.find((r) => r.field === 'cookie_ids')
    expect(row?.allEmpty).toBe(true)
  })
})

// The reason the comparison splits at all: whole-string equality would call
// these different and miss the cookie they share.
describe('sharing is decided per element, not per stored string', () => {
  it('finds one common id inside two different lists', () => {
    const { sharedValues, rows } = compareDocuments([
      profile('p:1', { cookie_ids: '019ec4d4,71b0aa2f,9f3c1d88' }),
      profile('p:2', { cookie_ids: '019ec4d4,4a2e7b10' }),
    ])
    expect(sharedValues).toEqual([{ field: 'cookie_ids', value: '019ec4d4', keys: ['p:1', 'p:2'] }])

    const cells = rows[0].cells
    expect(cells[0].map((v) => v.shared)).toEqual([true, false, false])
    expect(cells[1].map((v) => v.shared)).toEqual([true, false])
  })

  it('puts the widest agreement first', () => {
    const { sharedValues } = compareDocuments([
      profile('p:1', { ids: 'a,b' }),
      profile('p:2', { ids: 'a' }),
      profile('p:3', { ids: 'a,b' }),
    ])
    expect(sharedValues[0]).toEqual({ field: 'ids', value: 'a', keys: ['p:1', 'p:2', 'p:3'] })
    expect(sharedValues[1].value).toBe('b')
  })

  // An id repeated inside one key is still one key, not agreement with itself.
  it('does not call a value shared because it repeats in one key', () => {
    const { sharedValues } = compareDocuments([profile('p:1', { ids: 'a,a,a' }), profile('p:2', { ids: 'b' })])
    expect(sharedValues).toEqual([])
  })
})

describe('documentFields collapses the other types to one row', () => {
  it('a set becomes its members', () => {
    expect(documentFields({ key: 's', type: 'set', value: ['x', 'y'] }).get('members')).toBe('x,y')
  })

  // A zset arrives as {member, score}; the member is the identifier, the score
  // is when it was seen and is not what "shared" is asking about.
  it('a zset compares members, not scores', () => {
    const fields = documentFields({
      key: 'z',
      type: 'zset',
      value: [{ member: '2093263633890222080', score: 1787907913 }],
    })
    expect(fields.get('members')).toBe('2093263633890222080')
  })

  it('a string becomes a single value row', () => {
    expect(documentFields({ key: 's', type: 'string', value: 'hello' }).get('value')).toBe('hello')
  })
})
