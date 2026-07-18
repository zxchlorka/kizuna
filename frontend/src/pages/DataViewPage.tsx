import { useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { AlertTriangle, Loader2, Lock, RefreshCw } from 'lucide-react'
import { Sidebar } from '@/components/Sidebar'
import { TabBar } from '@/components/TabBar'
import { ConnectionChips } from '@/components/ConnectionChips'
import { EmptyState } from '@/components/EmptyState'
import { ProductionBanner } from '@/components/ProductionBanner'
import { RedisKeyView } from '@/components/RedisKeyView'
import { useConnectionStore } from '@/stores/connections'
import { tabPageId, useWorkspaceStore } from '@/stores/workspace'
import { IndexInspectorView } from '@/components/IndexInspectorView'
import { PgTableView } from '@/components/PgTableView'
import { SqlConsole } from '@/components/SqlConsole/SqlConsole'
import { RedisCli } from '@/components/redis/RedisCli/RedisCli'
import { KafkaTopicView } from '@/components/kafka/KafkaTopicView'
import { isRedisObjectType } from '@/lib/objectTypes'
import { isConnectionHealthStale, useConnectionHealthStore } from '@/stores/connectionHealth'
import { Button } from '@/components/ui/button'

export default function DataViewPage() {
  const { id } = useParams<{ id: string }>()
  const connections = useConnectionStore((state) => state.connections)
  const connectionsLoading = useConnectionStore((state) => state.loading)
  const connectionsLoadedOnce = useConnectionStore((state) => state.loadedOnce)
  const fetchConnections = useConnectionStore((state) => state.fetch)
  const hydrateHealth = useConnectionHealthStore((state) => state.hydrate)
  const healthEntry = useConnectionHealthStore((state) => (id ? state.entries[id] : undefined))
  const refreshHealth = useConnectionHealthStore((state) => state.refresh)
  const { tabs, activeTabId } = useWorkspaceStore()
  const openConnection = useWorkspaceStore((state) => state.openConnection)
  const activeTabByConnection = useWorkspaceStore((state) => state.activeTabByConnection)
  const setActiveTab = useWorkspaceStore((state) => state.setActiveTab)
  const currentConnection = connections.find((connection) => connection.id === id)
  const connectionTabs = tabs.filter((tab) => tabPageId(tab) === id)
  // Prefer the globally-active tab when it belongs to this connection; otherwise
  // fall back to this connection's last-active tab (or its most recent tab), so
  // switching back to a connection never shows a blank pane.
  const activeTab =
    connectionTabs.find((t) => t.id === activeTabId) ??
    connectionTabs.find((t) => t.id === (id ? activeTabByConnection[id] : undefined)) ??
    connectionTabs[connectionTabs.length - 1] ??
    null

  useEffect(() => {
    hydrateHealth()
  }, [hydrateHealth])

  // Keep the global activeTabId in sync with the resolved tab so TabBar (which
  // reads activeTabId) highlights the correct tab after a connection switch.
  useEffect(() => {
    if (activeTab && activeTab.id !== activeTabId) {
      setActiveTab(activeTab.id)
    }
  }, [activeTab, activeTabId, setActiveTab])

  useEffect(() => {
    if (id) {
      openConnection(id)
    }
  }, [id, openConnection])

  useEffect(() => {
    if (connections.length === 0 && !connectionsLoading && !connectionsLoadedOnce) {
      void fetchConnections()
    }
  }, [connections.length, connectionsLoadedOnce, connectionsLoading, fetchConnections])

  useEffect(() => {
    if (!id || !currentConnection) {
      return
    }
    if (!isConnectionHealthStale(healthEntry) && !healthEntry?.checking) {
      return
    }
    void refreshHealth(id).catch(() => {
      // Connection page renders the health failure as one status banner.
    })
  }, [currentConnection, healthEntry, id, refreshHealth])

  if (!id) return null

  const healthStatus = healthEntry?.status ?? 'unknown'
  const healthChecking = healthEntry?.checking ?? false
  const showHealthBanner = Boolean(
    currentConnection &&
      (healthChecking || healthStatus === 'unhealthy' || healthStatus === 'unknown')
  )

  return (
    <div className="flex h-screen flex-col bg-background">
      <ConnectionChips activeId={id} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar connId={id} />

        <div className="flex flex-1 flex-col overflow-hidden">
          <ProductionBanner visible={Boolean(currentConnection?.tags?.includes('production'))} />
          {showHealthBanner && (
            <div className="flex items-center justify-between gap-3 border-b border-border bg-muted/20 px-4 py-2 text-xs">
              <div className="flex min-w-0 items-center gap-2">
                {healthChecking ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                ) : (
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                )}
                <span className="min-w-0 truncate font-mono text-muted-foreground">
                  {healthChecking
                    ? 'Checking connection...'
                    : healthStatus === 'unhealthy'
                      ? healthEntry?.error ?? 'Connection is offline.'
                      : 'Connection health has not been checked yet.'}
                </span>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 shrink-0 gap-1.5 font-mono text-[11px]"
                disabled={healthChecking}
                onClick={() => void refreshHealth(id, { force: true }).catch(() => undefined)}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Retry
              </Button>
            </div>
          )}
          {currentConnection?.read_only && (
            <div className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/5 px-4 py-1.5 font-mono text-[11px] text-amber-600 dark:text-amber-400">
              <Lock className="h-3.5 w-3.5" />
              Read-only connection — data-modifying commands are blocked.
            </div>
          )}
          <TabBar connId={id} />

          <div className="flex flex-1 overflow-hidden">
            {activeTab ? (
              activeTab.kind === 'sql' ? (
                <SqlConsole tabId={activeTab.id} connId={activeTab.connId} />
              ) : activeTab.kind === 'redis-cli' ? (
                <RedisCli tabId={activeTab.id} connId={activeTab.connId} />
              ) : activeTab.objectType === 'index' ? (
                <IndexInspectorView
                  connId={activeTab.connId}
                  object={activeTab.object}
                  tabId={activeTab.id}
                />
              ) : activeTab.objectType === 'kafka_topic' ? (
                <KafkaTopicView
                  tabId={activeTab.id}
                  connId={activeTab.connId}
                  topic={activeTab.object}
                />
              ) : isRedisObjectType(activeTab.objectType) || activeTab.objectType === 'namespace' ? (
                <RedisKeyView
                  connId={activeTab.connId}
                  tabId={activeTab.id}
                  object={activeTab.object}
                  objectType={activeTab.objectType}
                  ttlSeconds={activeTab.ttlSeconds ?? null}
                />
              ) : (
                <PgTableView
                  connId={activeTab.connId}
                  object={activeTab.object}
                  tabId={activeTab.id}
                />
              )
            ) : (
              <div className="flex flex-1 items-center justify-center p-6">
                <div className="w-full max-w-md">
                  <EmptyState
                    variant="no_tables"
                    title={
                      currentConnection?.type === 'redis'
                        ? 'Select a Redis key'
                        : currentConnection?.type === 'kafka'
                          ? 'Select a Kafka topic'
                          : 'Select a table'
                    }
                    description={
                      currentConnection?.type === 'redis'
                        ? 'Choose a typed Redis key from the namespace tree. Value editing will follow in the next slice.'
                        : currentConnection?.type === 'kafka'
                          ? 'Choose a topic from the list to browse messages, partitions, and consumer groups.'
                          : 'Choose a table from the object tree to inspect rows, run DDL actions, and edit data.'
                    }
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
