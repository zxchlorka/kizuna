import { describe, expect, it } from 'vitest'
import {
  collectTags,
  filterConnectionsByName,
  filterConnectionsByTags,
  nextTagSelection,
} from './connectionGroups'
import type { Connection } from '@/types/api'

const conn = (name: string, tags?: string[]) => ({ id: name, name, tags }) as Connection

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
})
