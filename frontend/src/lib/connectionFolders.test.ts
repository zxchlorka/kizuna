import { describe, expect, it } from 'vitest'
import {
  arrangeAround,
  buildFolderTree,
  edgeScrollSpeed,
  flattenFolders,
  folderChildren,
  folderConnections,
  folderPath,
  isWithinFolder,
  occupiedFolderIds,
} from './connectionFolders'
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
    const pruned = buildFolderTree(folders, [conn('b', 'env2')], () => true)
    expect(pruned.children.map((n) => n.folder.id)).toEqual(['team'])
    expect(pruned.children[0].children[0].children.map((n) => n.folder.id)).toEqual(['env2'])
  })

  // A type tab: 'a' sits in project but is filtered out, so project goes;
  // Archive and env 10 hold nothing at all and stay to drop connections into.
  it('keeps folders the prune check spares', () => {
    const all = [conn('a', 'project'), conn('b', 'env2')]
    const occupied = occupiedFolderIds(folders, all)
    expect([...occupied].sort()).toEqual(['env2', 'project', 'team'])
    const tab = buildFolderTree(folders, [], (id) => occupied.has(id))
    expect(tab.children.map((n) => n.folder.id)).toEqual(['empty'])
  })

  it('orders sibling folders by position, ties by name', () => {
    const placed: Folder[] = [
      { id: 'b', name: 'B', position: 2 },
      { id: 'a', name: 'A', position: 3 },
      { id: 'z', name: 'Z', position: 1 },
      { id: 'y', name: 'Y', position: 2 },
    ]
    expect(buildFolderTree(placed, []).children.map((n) => n.folder.id)).toEqual(['z', 'b', 'y', 'a'])
    expect(folderChildren(placed, '').map((f) => f.id)).toEqual(['z', 'b', 'y', 'a'])
    // Dragging 'a' before 'b' among the top-level folders.
    expect(arrangeAround(folderChildren(placed, ''), 'a', 'b', false)).toEqual(['z', 'a', 'b', 'y'])
  })

  // The backend repairs loops on load, so this only pins that the walk cannot hang.
  it('does not recurse forever on a parent loop', () => {
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

describe('ordering inside a folder', () => {
  const c = (id: string, position?: number, folder_id?: string) => ({ id, name: id, position, folder_id }) as Connection

  it('sorts arranged connections by position and keeps the rest in config order after them', () => {
    const tree = buildFolderTree([], [c('stage'), c('prod', 2), c('dev'), c('local', 1)])
    expect(tree.connections.map((x) => x.id)).toEqual(['local', 'prod', 'stage', 'dev'])
  })

  it.each([
    ['before the target', 'prod', 'stage', false, ['prod', 'stage', 'dev']],
    ['after the target', 'stage', 'dev', true, ['prod', 'dev', 'stage']],
    ['dragged in from another folder', 'other', 'stage', true, ['stage', 'other', 'prod', 'dev']],
  ])('arrangeAround: %s', (_, dragged, target, after, want) => {
    const ordered = [c('stage', 1), c('prod', 2), c('dev', 3)]
    expect(arrangeAround(ordered, dragged, target, after)).toEqual(want)
  })

  it('folderConnections returns one folder in display order', () => {
    const all = [c('b', 2, 'f'), c('x', 1), c('a', 1, 'f')]
    expect(folderConnections(all, 'f').map((x) => x.id)).toEqual(['a', 'b'])
    expect(folderConnections(all, '').map((x) => x.id)).toEqual(['x'])
  })
})

describe('edgeScrollSpeed', () => {
  it('scrolls up near the top, down near the bottom, faster closer to the edge', () => {
    expect(edgeScrollSpeed(500, 1000)).toBe(0)
    expect(edgeScrollSpeed(0, 1000)).toBe(-22)
    expect(edgeScrollSpeed(-20, 1000)).toBe(-22)
    expect(edgeScrollSpeed(1000, 1000)).toBe(22)
    expect(edgeScrollSpeed(80, 1000)).toBeLessThan(0)
    expect(edgeScrollSpeed(80, 1000)).toBeGreaterThan(edgeScrollSpeed(10, 1000))
    expect(edgeScrollSpeed(960, 1000)).toBeGreaterThan(0)
  })
})
