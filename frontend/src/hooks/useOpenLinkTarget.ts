import { useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useWorkspaceStore } from '@/stores/workspace'
import { useDataStore } from '@/stores/data'
import { useKafkaStore } from '@/stores/kafka'
import { useToastStore } from '@/stores/toast'
import { buildRedisKey } from '@/lib/links'
import type { LinkRecord } from '@/types/api'

export function useOpenLinkTarget() {
  const navigate = useNavigate()
  const openTab = useWorkspaceStore((state) => state.openTab)
  const openTabWithFilter = useWorkspaceStore((state) => state.openTabWithFilter)
  const openConnection = useWorkspaceStore((state) => state.openConnection)
  const resolveObjectType = useDataStore((state) => state.resolveObjectType)
  const setSearch = useKafkaStore((state) => state.setSearch)
  const pushToast = useToastStore((state) => state.push)

  return useCallback(
    (link: LinkRecord, value: string) => {
      if (link.target_kind === 'redis') {
        const key = buildRedisKey(link.key_pattern ?? '', value)
        void resolveObjectType(link.target_conn_id, key)
          .then((objectType) => {
            openTab(link.target_conn_id, key, objectType)
            openConnection(link.target_conn_id)
            navigate(`/connections/${link.target_conn_id}`)
          })
          .catch(() => {
            pushToast({ tone: 'error', title: 'Not found', message: `Key ${key} not found` })
          })
        return
      }

      if (link.target_kind === 'postgres') {
        openTabWithFilter(
          link.target_conn_id,
          link.table ?? '',
          { column: link.column ?? '', op: 'eq', value },
          'table'
        )
        openConnection(link.target_conn_id)
        navigate(`/connections/${link.target_conn_id}`)
        return
      }

      const topic = link.target_topic ?? ''
      openTab(link.target_conn_id, topic, 'kafka_topic')
      openConnection(link.target_conn_id)
      navigate(`/connections/${link.target_conn_id}`)
      const tabId = `${link.target_conn_id}:kafka_topic:${topic}`
      void setSearch(link.target_conn_id, topic, tabId, link.target_field ?? '', value)
    },
    [navigate, openTab, openTabWithFilter, openConnection, resolveObjectType, setSearch, pushToast]
  )
}
