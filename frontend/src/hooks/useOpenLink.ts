import { useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useWorkspaceStore } from '@/stores/workspace'
import { useDataStore } from '@/stores/data'
import { useKafkaStore } from '@/stores/kafka'
import { useToastStore } from '@/stores/toast'
import { buildRedisKey } from '@/lib/links'
import type { LinkRecord } from '@/types/api'

// One end of a link, resolved to the four things navigation actually needs.
// The two ends store these under different field names, which is the only way
// "open the target" and "open the source" ever differed.
interface LinkEndpoint {
  connId: string
  kind: string
  // redis: the key pattern to substitute the value into.
  // postgres: the table. kafka: the topic.
  scope: string
  // postgres: the column to filter on. kafka: the json-path to search.
  field: string
}

function targetEndpoint(link: LinkRecord): LinkEndpoint {
  const base = { connId: link.target_conn_id, kind: link.target_kind }
  switch (link.target_kind) {
    case 'redis':
      return { ...base, scope: link.key_pattern ?? '', field: link.target_field ?? '' }
    case 'postgres':
      return { ...base, scope: link.table ?? '', field: link.column ?? '' }
    default:
      return { ...base, scope: link.target_topic ?? '', field: link.target_field ?? '' }
  }
}

function sourceEndpoint(link: LinkRecord): LinkEndpoint {
  return {
    connId: link.source_conn_id,
    kind: link.source_kind,
    scope: link.source_scope,
    field: link.source_field ?? '',
  }
}

function useOpenLinkEnd(resolve: (link: LinkRecord) => LinkEndpoint) {
  const navigate = useNavigate()
  const openTab = useWorkspaceStore((state) => state.openTab)
  const openTabWithFilter = useWorkspaceStore((state) => state.openTabWithFilter)
  const openConnection = useWorkspaceStore((state) => state.openConnection)
  const resolveObjectType = useDataStore((state) => state.resolveObjectType)
  const searchTopic = useKafkaStore((state) => state.searchTopic)
  const pushToast = useToastStore((state) => state.push)

  return useCallback(
    (link: LinkRecord, value: string) => {
      const end = resolve(link)
      const go = () => {
        openConnection(end.connId)
        navigate(`/connections/${end.connId}`)
      }

      if (end.kind === 'redis') {
        const key = buildRedisKey(end.scope, value)
        // The key's Redis type decides which view opens, and only the server
        // knows it — so navigation waits for that lookup and reports a miss
        // instead of opening a tab onto a key that is not there.
        void resolveObjectType(end.connId, key)
          .then((objectType) => {
            openTab(end.connId, key, objectType)
            go()
          })
          .catch(() => {
            pushToast({ tone: 'error', title: 'Not found', message: `Key ${key} not found` })
          })
        return
      }

      if (end.kind === 'postgres') {
        openTabWithFilter(end.connId, end.scope, { column: end.field, op: 'eq', value }, 'table')
        go()
        return
      }

      openTab(end.connId, end.scope, 'kafka_topic')
      go()
      void searchTopic(end.connId, end.scope, `${end.connId}:kafka_topic:${end.scope}`, end.field, value)
    },
    [resolve, navigate, openTab, openTabWithFilter, openConnection, resolveObjectType, searchTopic, pushToast]
  )
}

/** Navigates to a link's TARGET for a value read from its source. */
export function useOpenLinkTarget() {
  return useOpenLinkEnd(targetEndpoint)
}

/**
 * Navigates to a link's SOURCE for a value extracted from its target — the
 * reverse direction. Redis sources that extract from the value
 * (value_field/string_value) are unreachable this way; callers filter them out
 * via canReverse, so only key_capture redis sources reach the redis branch.
 */
export function useOpenLinkSource() {
  return useOpenLinkEnd(sourceEndpoint)
}
