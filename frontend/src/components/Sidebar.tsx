import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Eye, Lock, PanelLeftClose, PanelLeft, Plus, Settings, SlidersHorizontal, Table2, Zap } from 'lucide-react'
import { CreateKeyDialog } from '@/components/redis/CreateKeyDialog'
import { BulkActions } from '@/components/redis/BulkActions'
import { RedisKeyLookup } from '@/components/redis/RedisKeyLookup'
import { EmptyState } from '@/components/EmptyState'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { SchemaFilterButton } from '@/components/Sidebar/SchemaFilterButton'
import { SchemaFilterDialog } from '@/components/Sidebar/SchemaFilterDialog'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { fetchWithTimeout } from '@/lib/http'
import { cn } from '@/lib/utils'
import { ObjectTree } from '@/components/ObjectTree'
import { useConnectionStore } from '@/stores/connections'
import { useToastStore } from '@/stores/toast'
import { useWorkspaceStore, type TreeVisibilityKey } from '@/stores/workspace'

interface SidebarProps {
  connId: string
}

export function Sidebar({ connId }: SidebarProps) {
  const navigate = useNavigate()
  const [collapsed, setCollapsed] = useState(false)
  const [schemaDialogOpen, setSchemaDialogOpen] = useState(false)
  const [schemaFilterSaving, setSchemaFilterSaving] = useState(false)
  const [createKeyOpen, setCreateKeyOpen] = useState(false)
  const [createKeySaving, setCreateKeySaving] = useState(false)
  const connections = useConnectionStore((state) => state.connections)
  const connectionsLoading = useConnectionStore((state) => state.loading)
  const connectionsLoadedOnce = useConnectionStore((state) => state.loadedOnce)
  const updateVisibleSchemas = useConnectionStore((state) => state.updateVisibleSchemas)
  const pushToast = useToastStore((state) => state.push)
  const treeVisibility = useWorkspaceStore((state) => state.treeVisibility)
  const availableSchemas = useWorkspaceStore((state) => state.availableSchemasByConnection[connId] ?? [])
  const visibleSchemas = useWorkspaceStore((state) => state.visibleSchemasByConnection[connId] ?? null)
  const hydrateVisibleSchemas = useWorkspaceStore((state) => state.hydrateVisibleSchemas)
  const setTreeVisibility = useWorkspaceStore((state) => state.setTreeVisibility)
  const setVisibleSchemas = useWorkspaceStore((state) => state.setVisibleSchemas)
  const openTab = useWorkspaceStore((state) => state.openTab)
  const refreshTree = useWorkspaceStore((state) => state.refreshTree)
  const selectedNode = useWorkspaceStore((state) => state.selectedNodeByConnection[connId] ?? '')
  const setSelectedNode = useWorkspaceStore((state) => state.setSelectedNode)
  const [clusterNodes, setClusterNodes] = useState<string[]>([])

  const currentConnection = connections.find((connection) => connection.id === connId)
  const isRedisConnection = currentConnection?.type === 'redis'
  const isKafkaConnection = currentConnection?.type === 'kafka'
  const isClusterConnection = isRedisConnection && currentConnection?.mode === 'cluster'
  const readOnly = currentConnection?.read_only ?? false

  useEffect(() => {
    hydrateVisibleSchemas(connId, currentConnection?.visible_schemas)
  }, [connId, currentConnection?.visible_schemas, hydrateVisibleSchemas])

  useEffect(() => {
    if (!isClusterConnection) {
      setClusterNodes([])
      return
    }
    let cancelled = false
    fetchWithTimeout(`/api/connections/${connId}/info`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('failed to load connection info'))))
      .then((info: { extra?: { cluster_masters?: string[] } }) => {
        if (!cancelled) {
          setClusterNodes(info.extra?.cluster_masters ?? [])
        }
      })
      .catch(() => {
        if (!cancelled) {
          setClusterNodes([])
        }
      })
    return () => {
      cancelled = true
    }
  }, [connId, isClusterConnection])

  const hiddenSchemaCount = useMemo(() => {
    if (visibleSchemas === null) {
      return 0
    }
    return Math.max(0, availableSchemas.length - visibleSchemas.length)
  }, [availableSchemas.length, visibleSchemas])

  const filters: Array<{ key: TreeVisibilityKey; label: string; icon: typeof Table2 }> = [
    { key: 'showTables', label: 'Tables', icon: Table2 },
    { key: 'showViews', label: 'Views', icon: Eye },
    { key: 'showIndexes', label: 'Indexes', icon: Zap },
  ]

  const handleSaveVisibleSchemas = async (nextVisibleSchemas: string[] | null) => {
    setSchemaFilterSaving(true)
    setVisibleSchemas(connId, nextVisibleSchemas)

    try {
      await updateVisibleSchemas(connId, nextVisibleSchemas)
      setSchemaDialogOpen(false)
    } catch (error) {
      setVisibleSchemas(connId, currentConnection?.visible_schemas ?? null)
      pushToast({
        tone: 'error',
        title: 'Schema filter save failed',
        message: (error as Error).message,
      })
      throw error
    } finally {
      setSchemaFilterSaving(false)
    }
  }

  const handleCreateKey = async (payload: {
    key: string
    type: 'redis_string' | 'redis_hash' | 'redis_list' | 'redis_set' | 'redis_zset'
    ttl?: number | null
    value: string
    field?: string
    score?: number
    direction?: 'left' | 'right'
  }) => {
    setCreateKeySaving(true)
    try {
      let value: unknown = payload.value
      if (payload.type === 'redis_hash') {
        value = { [payload.field ?? 'field']: payload.value }
      } else if (payload.type === 'redis_zset') {
        value = [{ member: payload.value, score: payload.score ?? 0 }]
      }

      const res = await fetchWithTimeout(`/api/connections/${connId}/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: payload.key,
          type: payload.type,
          ttl: payload.ttl,
          value,
          direction: payload.direction,
        }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(body.error || res.statusText)
      }

      await refreshTree(connId)
      openTab(connId, payload.key, payload.type)
      setCreateKeyOpen(false)
      pushToast({
        tone: 'success',
        title: 'Redis key created',
        message: payload.key,
      })
    } catch (error) {
      pushToast({
        tone: 'error',
        title: 'Create key failed',
        message: (error as Error).message,
      })
      throw error
    } finally {
      setCreateKeySaving(false)
    }
  }

  return (
    <div
      className={cn(
        'flex h-full flex-col border-r border-border bg-background transition-all',
        collapsed ? 'w-10' : 'w-72'
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border p-2">
        {!collapsed && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => navigate('/')}
              className="flex items-center gap-1 rounded px-1.5 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
              <span>Back</span>
            </button>
            <button
              onClick={() => navigate('/settings')}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              title="Settings"
            >
              <Settings className="h-4 w-4" />
            </button>
          </div>
        )}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {collapsed ? (
            <PanelLeft className="h-4 w-4" />
          ) : (
            <PanelLeftClose className="h-4 w-4" />
          )}
        </button>
      </div>

      {/* Tree */}
      {!collapsed && (
        <div className="flex-1 overflow-auto p-2">
          {!currentConnection ? (
            connectionsLoading || !connectionsLoadedOnce ? (
              <LoadingSkeleton variant="tree" />
            ) : (
              <EmptyState
                variant="no_tables"
                compact
                title="Connection not found"
                description="Go back to the connection list and choose an existing connection."
              />
            )
          ) : isRedisConnection ? (
            <div className="mb-3 rounded-sm border border-border bg-muted/10 p-2">
              <div className="flex items-center justify-between gap-2 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                <div className="flex items-center gap-2">
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                  Redis Tree
                </div>
                {readOnly ? (
                  <span className="inline-flex items-center gap-1 rounded-sm border border-amber-500/30 bg-amber-500/5 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.12em] text-amber-600 dark:text-amber-400">
                    <Lock className="h-3 w-3" />
                    Read-only
                  </span>
                ) : (
                  <div className="flex items-center gap-2">
                    <BulkActions connId={connId} />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 w-7 shrink-0 p-0"
                      title="New Key"
                      aria-label="New Key"
                      onClick={() => setCreateKeyOpen(true)}
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}
              </div>
              {isClusterConnection && clusterNodes.length > 0 && (
                <div className="mt-2 flex items-center gap-2">
                  <span className="shrink-0 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Node</span>
                  <Select
                    value={selectedNode || '__all__'}
                    onValueChange={(value) => void setSelectedNode(connId, value === '__all__' ? '' : value)}
                  >
                    <SelectTrigger className="h-7 flex-1 font-mono text-[11px]">
                      <SelectValue placeholder="All masters" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__all__">All masters</SelectItem>
                      {clusterNodes.map((node) => (
                        <SelectItem key={node} value={node} className="font-mono text-[11px]">
                          {node}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          ) : isKafkaConnection ? (
            <div className="mb-3 rounded-sm border border-border bg-muted/10 p-2">
              <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                <SlidersHorizontal className="h-3.5 w-3.5" />
                Kafka Topics
              </div>
            </div>
          ) : (
            <div className="mb-3 rounded-sm border border-border bg-muted/10 p-2">
              <div className="mb-2 flex items-center justify-between gap-2 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                <div className="flex items-center gap-2">
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                  Tree Filters
                </div>
                <SchemaFilterButton
                  hiddenCount={hiddenSchemaCount}
                  disabled={availableSchemas.length === 0}
                  onClick={() => setSchemaDialogOpen(true)}
                />
              </div>
              <div className="grid grid-cols-3 gap-1">
                {filters.map(({ key, label, icon: Icon }) => {
                  const active = treeVisibility[key]
                  return (
                    <Button
                      key={key}
                      type="button"
                      size="sm"
                      variant={active ? 'secondary' : 'outline'}
                      className="h-8 gap-1.5 px-2 font-mono text-[11px]"
                      onClick={() => setTreeVisibility(key, !active)}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      {label}
                    </Button>
                  )
                })}
              </div>
            </div>
          )}
          {currentConnection && isRedisConnection && <RedisKeyLookup connId={connId} />}
          {currentConnection && <ObjectTree connId={connId} />}
          {currentConnection && !isRedisConnection && (
            <SchemaFilterDialog
              open={schemaDialogOpen}
              saving={schemaFilterSaving}
              schemas={availableSchemas}
              selectedSchemas={visibleSchemas}
              onOpenChange={setSchemaDialogOpen}
              onSave={handleSaveVisibleSchemas}
            />
          )}
          {currentConnection && isRedisConnection && (
            <CreateKeyDialog
              open={createKeyOpen}
              saving={createKeySaving}
              onOpenChange={setCreateKeyOpen}
              onConfirm={handleCreateKey}
            />
          )}
        </div>
      )}
    </div>
  )
}
