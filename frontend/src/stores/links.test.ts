import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useLinksStore } from '@/stores/links'
import type { LinkRecord } from '@/types/api'

// removeForConnection is the local half of the connection-delete cascade: the
// backend already dropped these links in the same DELETE, so the store only has
// to forget them. It must never issue a request of its own, or deleting a
// connection would fire one call per link.
function link(id: string, source: string, target: string): LinkRecord {
  return {
    id,
    source_conn_id: source,
    source_kind: 'kafka',
    source_scope: 'events',
    source_field: 'uid',
    target_conn_id: target,
    target_kind: 'redis',
    key_pattern: 'w:*',
  }
}

beforeEach(() => {
  useLinksStore.setState({ links: [], loaded: false })
})

describe('removeForConnection', () => {
  it('forgets links where the connection is the source', () => {
    useLinksStore.setState({ links: [link('l1', 'redis-1', 'kafka-1'), link('l2', 'pg-1', 'kafka-1')] })

    useLinksStore.getState().removeForConnection('redis-1')

    expect(useLinksStore.getState().links.map((l) => l.id)).toEqual(['l2'])
  })

  it('forgets links where the connection is the target', () => {
    useLinksStore.setState({ links: [link('l1', 'pg-1', 'redis-1'), link('l2', 'pg-1', 'kafka-1')] })

    useLinksStore.getState().removeForConnection('redis-1')

    expect(useLinksStore.getState().links.map((l) => l.id)).toEqual(['l2'])
  })

  it('forgets a self-link and keeps unrelated links', () => {
    useLinksStore.setState({
      links: [link('self', 'redis-1', 'redis-1'), link('both-ways', 'redis-1', 'kafka-1'), link('other', 'pg-1', 'kafka-1')],
    })

    useLinksStore.getState().removeForConnection('redis-1')

    expect(useLinksStore.getState().links.map((l) => l.id)).toEqual(['other'])
  })

  it('issues no network request', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
    useLinksStore.setState({ links: [link('l1', 'redis-1', 'kafka-1')] })

    useLinksStore.getState().removeForConnection('redis-1')

    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('leaves the list untouched when nothing references the connection', () => {
    const links = [link('l1', 'pg-1', 'kafka-1')]
    useLinksStore.setState({ links })

    useLinksStore.getState().removeForConnection('redis-1')

    expect(useLinksStore.getState().links).toBe(links)
  })
})
