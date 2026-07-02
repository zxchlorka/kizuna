import { useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useWorkspaceStore } from '@/stores/workspace'
import { useDataStore } from '@/stores/data'
import { useKafkaStore } from '@/stores/kafka'
import { useToastStore } from '@/stores/toast'
import { buildRedisKey } from '@/lib/links'
import type { LinkRecord } from '@/types/api'

// useOpenLinkSource navigates to a link's SOURCE for a value extracted from its
// target — the reverse of useOpenLinkTarget. Redis sources that extract from the
// value (value_field/string_value) are unreachable; callers filter them out via
// canReverse, so only key_capture redis sources reach the redis branch here.
export function useOpenLinkSource() {
  const navigate = useNavigate()
  const openTab = useWorkspaceStore((state) => state.openTab)
  const openTabWithFilter = useWorkspaceStore((state) => state.openTabWithFilter)
  const openConnection = useWorkspaceStore((state) => state.openConnection)
  const resolveObjectType = useDataStore((state) => state.resolveObjectType)
  const setSearch = useKafkaStore((state) => state.setSearch)
  const pushToast = useToastStore((state) => state.push)

  return useCallback(
    (link: LinkRecord, value: string) => {
      if (link.source_kind === 'redis') {
        const key = buildRedisKey(link.source_scope, value)
        void resolveObjectType(link.source_conn_id, key)
          .then((objectType) => {
            openTab(link.source_conn_id, key, objectType)
            openConnection(link.source_conn_id)
            navigate(`/connections/${link.source_conn_id}`)
          })
          .catch(() => {
            pushToast({ tone: 'error', title: 'Not found', message: `Key ${key} not found` })
          })
        return
      }

      if (link.source_kind === 'postgres') {
        openTabWithFilter(
          link.source_conn_id,
          link.source_scope,
          { column: link.source_field ?? '', op: 'eq', value },
          'table'
        )
        openConnection(link.source_conn_id)
        navigate(`/connections/${link.source_conn_id}`)
        return
      }

      const topic = link.source_scope
      openTab(link.source_conn_id, topic, 'kafka_topic')
      openConnection(link.source_conn_id)
      navigate(`/connections/${link.source_conn_id}`)
      const tabId = `${link.source_conn_id}:kafka_topic:${topic}`
      void setSearch(link.source_conn_id, topic, tabId, link.source_field ?? '', value)
    },
    [navigate, openTab, openTabWithFilter, openConnection, resolveObjectType, setSearch, pushToast]
  )
}
