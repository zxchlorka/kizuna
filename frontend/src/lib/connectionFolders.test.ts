import { describe, expect, it } from 'vitest'
import { buildFolderTree, flattenFolders, folderPath, isWithinFolder } from './connectionFolders'
import type { Connection, Folder } from '@/types/api'

const folders: Folder[] = [
  { id: 'team', name: 'Team' },
  { id: 'project', name: 'Project', parent_id: 'team' },
  { id: 'env10', name: 'env 10', parent_id: 'project' },
  { id: 'env2', name: 'env 2', parent_id: 'project' },
  { id: 'empty', name: 'Archive' },
]
const conn = (id: string, folder_id?: string) => ({ id, name: id, folder_id }) as Connection

describe('buildFolderTree', () => {
  const tree = buildFolderTree(folders, [conn('root'), conn('a', 'project'), conn('b', 'env2'), conn('orphan', 'gone')])

  it('nests folders and sorts them by name, numbers naturally', () => {
    expect(tree.children.map((n) => n.folder.id)).toEqual(['empty', 'team'])
    const project = tree.children[1].children[0]
    expect(project.children.map((n) => n.folder.name)).toEqual(['env 2', 'env 10'])
  })

  it('counts connections of the whole branch', () => {
    expect(tree.children[1].total).toBe(2)
    expect(tree.children[1].children[0].connections.map((c) => c.id)).toEqual(['a'])
  })

  it('puts a connection of a missing folder at top level', () => {
    expect(tree.connections.map((c) => c.id)).toEqual(['root', 'orphan'])
  })

  it('prunes branches without connections when asked', () => {
    const pruned = buildFolderTree(folders, [conn('b', 'env2')], true)
    expect(pruned.children.map((n) => n.folder.id)).toEqual(['team'])
    expect(pruned.children[0].children[0].children.map((n) => n.folder.id)).toEqual(['env2'])
  })

  it('survives a parent loop in a hand-edited config', () => {
    const loop: Folder[] = [
      { id: 'x', name: 'x', parent_id: 'y' },
      { id: 'y', name: 'y', parent_id: 'x' },
    ]
    expect(buildFolderTree(loop, []).children).toEqual([])
  })
})

describe('folder helpers', () => {
  it('folderPath walks up to the top', () => {
    expect(folderPath(folders, 'env2')).toEqual(['Team', 'Project', 'env 2'])
    expect(folderPath(folders, undefined)).toEqual([])
  })

  it.each([
    ['env2', 'team', true],
    ['team', 'team', true],
    ['team', 'env2', false],
    ['empty', 'team', false],
  ])('isWithinFolder(%s, %s) = %s', (id, ancestor, want) => {
    expect(isWithinFolder(folders, id, ancestor)).toBe(want)
  })

  it('flattenFolders lists in tree order with depth', () => {
    expect(flattenFolders(folders).map(({ folder, depth }) => `${depth}:${folder.id}`)).toEqual([
      '0:empty',
      '0:team',
      '1:project',
      '2:env2',
      '2:env10',
    ])
  })
})
