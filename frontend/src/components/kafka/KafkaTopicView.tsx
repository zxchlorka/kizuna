import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Layers, Lock, MessagesSquare, RefreshCw, Send, Users } from 'lucide-react'
import { KafkaConsumerGroups } from '@/components/kafka/KafkaConsumerGroups'
import { KafkaMessageBrowser } from '@/components/kafka/KafkaMessageBrowser'
import { KafkaPartitionsTable } from '@/components/kafka/KafkaPartitionsTable'
import { KafkaProduceModal } from '@/components/kafka/KafkaProduceModal'
import { CreateLinkDialog } from '@/components/kafka/CreateLinkDialog'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { Button } from '@/components/ui/button'
import { buildRedisKey } from '@/lib/links'
import { cn } from '@/lib/utils'
import { useConnectionStore } from '@/stores/connections'
import { useDataStore } from '@/stores/data'
import { useKafkaStore } from '@/stores/kafka'
import { useLinksStore } from '@/stores/links'
import { useToastStore } from '@/stores/toast'
import { useWorkspaceStore } from '@/stores/workspace'
import type { KafkaMessageRow } from '@/stores/kafka'
import type { LinkRecord } from '@/types/api'

interface KafkaTopicViewProps {
  tabId: string
  connId: string
  topic: string
}

type TopicTab = 'messages' | 'partitions' | 'groups'

const tabs: Array<{ id: TopicTab; label: string; icon: typeof MessagesSquare }> = [
  { id: 'messages', label: 'Messages', icon: MessagesSquare },
  { id: 'partitions', label: 'Partitions', icon: Layers },
  { id: 'groups', label: 'Consumer Groups', icon: Users },
]

export function KafkaTopicView({ tabId, connId, topic }: KafkaTopicViewProps) {
  const [activeTab, setActiveTab] = useState<TopicTab>('messages')
  const [produceOpen, setProduceOpen] = useState(false)
  const readOnly = useConnectionStore(
    (state) => state.connections.find((connection) => connection.id === connId)?.read_only ?? false
  )
  const tab = useKafkaStore((state) => state.tabs[tabId])
  const fetchTopicChildren = useKafkaStore((state) => state.fetchTopicChildren)
  const fetchMessages = useKafkaStore((state) => state.fetchMessages)
  const fetchOlderMessages = useKafkaStore((state) => state.fetchOlderMessages)
  const setPartitionFilter = useKafkaStore((state) => state.setPartitionFilter)
  const setSearch = useKafkaStore((state) => state.setSearch)
  const clearSearch = useKafkaStore((state) => state.clearSearch)
  const navigate = useNavigate()
  const openTab = useWorkspaceStore((state) => state.openTab)
  const openTabWithFilter = useWorkspaceStore((state) => state.openTabWithFilter)
  const resolveObjectType = useDataStore((state) => state.resolveObjectType)
  const fetchLinks = useLinksStore((state) => state.fetch)
  const linksFor = useLinksStore((state) => state.linksFor)
  const links = useLinksStore((state) => state.links)
  const pushToast = useToastStore((state) => state.push)
  const [createLinkOpen, setCreateLinkOpen] = useState(false)
  const [createLinkFields, setCreateLinkFields] = useState<string[]>([])

  useEffect(() => {
    void fetchMessages(connId, topic, tabId).finally(() => {
      void fetchTopicChildren(connId, topic, tabId)
    })
  }, [connId, fetchMessages, fetchTopicChildren, tabId, topic])

  useEffect(() => {
    void fetchLinks().catch(() => undefined)
  }, [fetchLinks])

  const partitions = useMemo(
    () => (tab?.children ?? []).filter((child) => child.type === 'kafka_partition'),
    [tab?.children]
  )
  const groups = useMemo(
    () => (tab?.children ?? []).filter((child) => child.type === 'kafka_consumer_group'),
    [tab?.children]
  )
  const totalMessages = useMemo(
    () => partitions.reduce((sum, partition) => sum + partition.row_count, 0),
    [partitions]
  )

  const refreshAll = () => {
    void fetchTopicChildren(connId, topic, tabId)
    void fetchMessages(connId, topic, tabId)
  }

  const topicLinks = useMemo(() => linksFor(connId, topic), [linksFor, links, connId, topic])

  const handleOpenLink = (link: LinkRecord, value: string) => {
    if (link.target_kind === 'redis') {
      const key = buildRedisKey(link.key_pattern ?? '', value)
      void resolveObjectType(link.target_conn_id, key)
        .then((objectType) => {
          openTab(link.target_conn_id, key, objectType)
          navigate(`/connections/${link.target_conn_id}`)
        })
        .catch(() => {
          pushToast({ tone: 'error', title: 'Not found', message: `Key ${key} not found` })
        })
      return
    }
    openTabWithFilter(
      link.target_conn_id,
      link.table ?? '',
      { column: link.column ?? '', op: 'eq', value },
      'table'
    )
    navigate(`/connections/${link.target_conn_id}`)
  }

  const handleCreateLink = (message: KafkaMessageRow) => {
    let fields: string[] = []
    try {
      const parsed = JSON.parse(message.value)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        fields = Object.keys(parsed)
      }
    } catch {
      fields = []
    }
    setCreateLinkFields(fields)
    setCreateLinkOpen(true)
  }

  return (
    <div className="flex flex-1 overflow-auto p-6">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
        <div className="rounded-sm border border-border bg-card">
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-4 py-4">
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-sm border border-orange-500/20 bg-orange-500/5">
                <MessagesSquare className="h-4.5 w-4.5 text-orange-500" />
              </div>
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Kafka topic</div>
                <h2 className="mt-1 truncate font-mono text-lg font-semibold text-foreground">{topic}</h2>
                <div className="mt-2 flex flex-wrap items-center gap-2 font-mono text-[11px] text-muted-foreground">
                  <span>{partitions.length} partitions</span>
                  <span>·</span>
                  <span>~{totalMessages.toLocaleString()} messages</span>
                  <span>·</span>
                  <span>{groups.length} consumer groups</span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {readOnly ? (
                <span className="inline-flex items-center gap-1.5 rounded-sm border border-amber-500/30 bg-amber-500/5 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-amber-600 dark:text-amber-400">
                  <Lock className="h-3 w-3" />
                  Read-only
                </span>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  className="h-8 gap-1.5 bg-orange-500 text-white hover:bg-orange-400"
                  onClick={() => setProduceOpen(true)}
                >
                  <Send className="h-3.5 w-3.5" />
                  Produce
                </Button>
              )}
              <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5" onClick={refreshAll} disabled={tab?.childrenLoading}>
                <RefreshCw className={cn('h-3.5 w-3.5', tab?.childrenLoading && 'animate-spin')} />
                Refresh
              </Button>
            </div>
          </div>

          <div className="flex items-center gap-1 px-4 pt-2">
            {tabs.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setActiveTab(id)}
                className={cn(
                  'flex items-center gap-1.5 rounded-t-sm border-b-2 px-3 py-2 font-mono text-xs transition-colors',
                  activeTab === id
                    ? 'border-orange-500 text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
                {id === 'groups' && groups.length > 0 && (
                  <span className="rounded-sm border border-border bg-muted/20 px-1 text-[10px]">{groups.length}</span>
                )}
              </button>
            ))}
          </div>
        </div>

        {tab?.childrenError && activeTab !== 'messages' ? (
          <ErrorBanner message={tab.childrenError} onRetry={() => void fetchTopicChildren(connId, topic, tabId)} />
        ) : null}

        {activeTab === 'messages' && (
          <KafkaMessageBrowser
            messages={tab?.messages ?? []}
            loading={tab?.messagesLoading ?? false}
            loadingOlder={tab?.loadingOlder ?? false}
            error={tab?.messagesError ?? null}
            hasOlder={tab?.hasOlder ?? false}
            partitionCount={partitions.length}
            partitionFilter={tab?.partitionFilter ?? null}
            searchActive={tab?.searchActive ?? false}
            scanned={tab?.scanned ?? 0}
            onPartitionChange={(partition) => void setPartitionFilter(connId, topic, tabId, partition)}
            onRefresh={() => void fetchMessages(connId, topic, tabId)}
            onLoadOlder={() => void fetchOlderMessages(connId, topic, tabId)}
            onSearch={(field, value) => void setSearch(connId, topic, tabId, field, value)}
            onClearSearch={() => void clearSearch(connId, topic, tabId)}
            links={topicLinks}
            onOpenLink={handleOpenLink}
            onCreateLink={handleCreateLink}
          />
        )}

        {activeTab === 'partitions' &&
          (tab?.childrenLoading && partitions.length === 0 ? (
            <LoadingSkeleton variant="table" />
          ) : (
            <KafkaPartitionsTable partitions={partitions} />
          ))}

        {activeTab === 'groups' &&
          (tab?.childrenLoading && groups.length === 0 ? (
            <LoadingSkeleton variant="table" />
          ) : (
            <KafkaConsumerGroups groups={groups} />
          ))}
      </div>

      <KafkaProduceModal
        open={produceOpen}
        connId={connId}
        topic={topic}
        partitionCount={partitions.length}
        onOpenChange={setProduceOpen}
        onProduced={() => {
          void fetchTopicChildren(connId, topic, tabId)
          void fetchMessages(connId, topic, tabId)
        }}
      />

      <CreateLinkDialog
        open={createLinkOpen}
        sourceConnId={connId}
        topic={topic}
        fieldOptions={createLinkFields}
        onOpenChange={setCreateLinkOpen}
      />
    </div>
  )
}
