import { describe, expect, it } from 'vitest'
import {
  collectTags,
  filterConnectionsByName,
  filterConnectionsByTags,
  groupConnectionsByTag,
  nextTagSelection,
} from './connectionGroups'
import type { Connection } from '@/types/api'

const conn = (name: string, tags?: string[]) => ({ id: name, name, tags }) as Connection

describe('groupConnectionsByTag', () => {
  it('orders environments by risk, other tags alphabetically, untagged last', () => {
    const groups = groupConnectionsByTag([
      conn('a'),
      conn('b', ['zeta']),
      conn('c', ['dev']),
      conn('d', ['Production']),
      conn('e', ['alpha']),
      conn('f', ['stage']),
    ])
    expect(groups.map((g) => g.key)).toEqual(['production', 'stage', 'dev', 'alpha', 'zeta', ''])
  })

  it('puts a multi-tag connection under its first tag only and ignores blank tags', () => {
    const groups = groupConnectionsByTag([conn('a', ['dev', 'prod']), conn('b', [' ', 'dev']), conn('c', ['DEV'])])
    expect(groups).toHaveLength(1)
    expect(groups[0].connections.map((c) => c.name)).toEqual(['a', 'b', 'c'])
  })
})

describe('filterConnectionsByName', () => {
  it('matches case-insensitively as a substring and passes everything on blank input', () => {
    const list = [conn('Stage Redis'), conn('prod pg')]
    expect(filterConnectionsByName(list, ' REDIS ').map((c) => c.name)).toEqual(['Stage Redis'])
    expect(filterConnectionsByName(list, '  ')).toBe(list)
  })
})

describe('tag filter', () => {
  const list = [conn('a', ['staging', 'dev']), conn('b', ['dev']), conn('c', ['prod']), conn('d')]

  it('collects distinct tags with counts in risk order', () => {
    expect(collectTags(list).map((t) => [t.key, t.count])).toEqual([['prod', 1], ['staging', 1], ['dev', 2]])
  })

  it('keeps connections with any selected tag, or all when none is selected', () => {
    expect(filterConnectionsByTags(list, new Set(['dev'])).map((c) => c.name)).toEqual(['a', 'b'])
    expect(filterConnectionsByTags(list, new Set(['dev', 'prod'])).map((c) => c.name)).toEqual(['a', 'b', 'c'])
    expect(filterConnectionsByTags(list, new Set())).toBe(list)
  })

  it('selects like Gmail: click narrows to one tag, modifier-click adds or removes', () => {
    const pick = (selected: string[], key: string, additive = false) => [...nextTagSelection(new Set(selected), key, additive)]
    expect(pick([], 'dev')).toEqual(['dev'])
    expect(pick(['dev', 'prod'], 'dev')).toEqual(['dev'])
    expect(pick(['dev'], 'prod')).toEqual(['prod'])
    expect(pick(['dev'], 'dev')).toEqual([])
    expect(pick(['dev'], 'prod', true)).toEqual(['dev', 'prod'])
    expect(pick(['dev', 'prod'], 'dev', true)).toEqual(['prod'])
  })

  it('groups a multi-tag connection under the selected tag, not its first one', () => {
    const groups = groupConnectionsByTag(filterConnectionsByTags(list, new Set(['dev'])), new Set(['dev']))
    expect(groups.map((g) => [g.key, g.connections.length])).toEqual([['dev', 2]])
  })
})
