import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  CircleDot,
  Database,
  Eye,
  Folder,
  FolderOpen,
  Hash,
  List,
  ListOrdered,
  MoreHorizontal,
  Plus,
  Table2,
  Zap,
} from 'lucide-react'
import { CreateTableForm } from '@/components/DDL/CreateTableForm'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { getObjectTypeLabel, isRedisNamespace } from '@/lib/objectTypes'
import { useConnectionStore } from '@/stores/connections'
import { useDataStore } from '@/stores/data'
import { useToastStore } from '@/stores/toast'
import { useWorkspaceStore } from '@/stores/workspace'
import type { DDLColumnInput, ObjectItem, ObjectType } from '@/types/api'

interface SchemaChildGroup {
  primaryItems: ObjectItem[]
  indexesByParent: Map<string, ObjectItem[]>
  unattachedIndexes: ObjectItem[]
}

interface ObjectTreeProps {
  connId: string
}

function buildTreeKey(connId: string, path = ''): string {
  return `${connId}::${path}`
}

function equalSchemaLists(left: string[] | null, right: string[] | null) {
  if (left === right) return true
  if (left === null || right === null) return false
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function normalizeVisibleSchemas(availableSchemas: string[], selectedSchemas: string[] | null): string[] | null {
  if (selectedSchemas === null) {
    return null
  }

  const available = new Set(availableSchemas)
  const prunedSelection = selectedSchemas.filter((schema) => available.has(schema))
  const selectedSet = new Set(prunedSelection)
  const appendedNewSchemas = availableSchemas.filter((schema) => !selectedSet.has(schema))
  return [...prunedSelection, ...appendedNewSchemas]
}

function groupSchemaChildren(items: ObjectItem[], showTables: boolean): SchemaChildGroup {
  const indexesByParent = new Map<string, ObjectItem[]>()
  const unattachedIndexes: ObjectItem[] = []

  items.forEach((item) => {
    if (item.type !== 'index') {
      return
    }
    if (!item.parent_name) {
      unattachedIndexes.push(item)
      return
    }
    const existing = indexesByParent.get(item.parent_name) ?? []
    existing.push(item)
    indexesByParent.set(item.parent_name, existing)
  })

  const primaryItems = items.filter((item) => {
    if (item.type === 'index') {
      return false
    }
    if (item.type === 'table' && !showTables) {
      return indexesByParent.has(item.name)
    }
    return true
  })

  indexesByParent.forEach((indexes, parentName) => {
    const hasVisibleParent = primaryItems.some((item) => item.type === 'table' && item.name === parentName)
    if (!hasVisibleParent) {
      unattachedIndexes.push(...indexes)
      indexesByParent.delete(parentName)
    }
  })

  return { primaryItems, indexesByParent, unattachedIndexes }
}

function formatCount(n: number) {
  if (n >= 1000000) return `~${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `~${(n / 1000).toFixed(0)}K`
  return `${n}`
}

function formatRedisTTL(ttlSeconds?: number) {
  if (ttlSeconds === undefined || ttlSeconds === null || ttlSeconds === -2) {
    return null
  }
  if (ttlSeconds === -1) {
    return 'No TTL'
  }

  const seconds = Math.max(0, Math.floor(ttlSeconds))
  if (seconds >= 86400) {
    const days = Math.floor(seconds / 86400)
    const hours = Math.floor((seconds % 86400) / 3600)
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  }
  if (seconds >= 3600) {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  }
  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60)
    const remaining = seconds % 60
    return remaining > 0 ? `${minutes}m ${remaining}s` : `${minutes}m`
  }
  return `${seconds}s`
}

function getIcon(type: string, expanded?: boolean) {
  switch (type) {
    case 'schema':
      return expanded ? (
        <FolderOpen className="h-4 w-4 text-[hsl(var(--accent))]" />
      ) : (
        <Folder className="h-4 w-4 text-muted-foreground" />
      )
    case 'namespace':
      return expanded ? (
        <FolderOpen className="h-4 w-4 text-red-500" />
      ) : (
        <Folder className="h-4 w-4 text-red-500" />
      )
    case 'table':
      return <Table2 className="h-4 w-4 text-blue-500" />
    case 'view':
      return <Eye className="h-4 w-4 text-purple-500" />
    case 'index':
      return <Zap className="h-4 w-4 text-yellow-500" />
    case 'redis_string':
      return <Database className="h-4 w-4 text-red-500" />
    case 'redis_hash':
      return <Hash className="h-4 w-4 text-emerald-500" />
    case 'redis_list':
      return <List className="h-4 w-4 text-sky-500" />
    case 'redis_set':
      return <CircleDot className="h-4 w-4 text-violet-500" />
    case 'redis_zset':
      return <ListOrdered className="h-4 w-4 text-amber-500" />
    case 'redis_stream':
      return <Activity className="h-4 w-4 text-orange-500" />
    default:
      return <Table2 className="h-4 w-4 text-muted-foreground" />
    }
}

export function ObjectTree({ connId }: ObjectTreeProps) {
  const connections = useConnectionStore((state) => state.connections)
  const updateVisibleSchemas = useConnectionStore((state) => state.updateVisibleSchemas)
  const treeItems = useWorkspaceStore((state) => state.treeItems)
  const treeLoading = useWorkspaceStore((state) => state.treeLoading)
  const treeError = useWorkspaceStore((state) => state.treeErrorsByConnection[connId] ?? null)
  const expandedSchemas = useWorkspaceStore((state) => state.expandedSchemas)
  const treeVisibility = useWorkspaceStore((state) => state.treeVisibility)
  const visibleSchemasByConnection = useWorkspaceStore((state) => state.visibleSchemasByConnection)
  const fetchTree = useWorkspaceStore((state) => state.fetchTree)
  const refreshTree = useWorkspaceStore((state) => state.refreshTree)
  const toggleSchema = useWorkspaceStore((state) => state.toggleSchema)
  const setVisibleSchemas = useWorkspaceStore((state) => state.setVisibleSchemas)
  const openTab = useWorkspaceStore((state) => state.openTab)
  const ddl = useDataStore((state) => state.ddl)
  const pushToast = useToastStore((state) => state.push)
  const [createTableSchema, setCreateTableSchema] = useState<string | null>(null)
  const [isCreatingTable, setIsCreatingTable] = useState(false)

  useEffect(() => {
    void fetchTree(connId)
  }, [connId, fetchTree])

  const currentConnection = connections.find((connection) => connection.id === connId)
  const isRedisConnection = currentConnection?.type === 'redis'
  const rootItems = treeItems[buildTreeKey(connId)] || []

  const availableSchemas = useMemo(
    () => rootItems.filter((item) => item.type === 'schema').map((item) => item.name),
    [rootItems]
  )
  const persistedVisibleSchemas = currentConnection?.visible_schemas ?? null
  const visibleSchemaSelection = visibleSchemasByConnection[connId] ?? persistedVisibleSchemas
  const normalizedVisibleSchemas = useMemo(
    () => normalizeVisibleSchemas(availableSchemas, visibleSchemaSelection),
    [availableSchemas, visibleSchemaSelection]
  )
  const visibleSchemaSet = useMemo(
    () => new Set(normalizedVisibleSchemas ?? availableSchemas),
    [availableSchemas, normalizedVisibleSchemas]
  )
  const filteredRootItems = useMemo(
    () => rootItems.filter((item) => item.type !== 'schema' || visibleSchemaSet.has(item.name)),
    [rootItems, visibleSchemaSet]
  )

  useEffect(() => {
    if (isRedisConnection || !treeItems[buildTreeKey(connId)] || visibleSchemaSelection === null) {
      return
    }
    if (equalSchemaLists(visibleSchemaSelection, normalizedVisibleSchemas)) {
      return
    }

    setVisibleSchemas(connId, normalizedVisibleSchemas)
    if (!equalSchemaLists(persistedVisibleSchemas, normalizedVisibleSchemas)) {
      void updateVisibleSchemas(connId, normalizedVisibleSchemas).catch((error: Error) => {
        pushToast({
          tone: 'error',
          title: 'Schema filter sync failed',
          message: error.message,
        })
      })
    }
  }, [
    connId,
    isRedisConnection,
    normalizedVisibleSchemas,
    persistedVisibleSchemas,
    pushToast,
    setVisibleSchemas,
    treeItems,
    updateVisibleSchemas,
    visibleSchemaSelection,
  ])

  const handleNodeClick = (path: string) => {
    toggleSchema(connId, path)
    if (!expandedSchemas.has(buildTreeKey(connId, path)) && !treeItems[buildTreeKey(connId, path)]) {
      void fetchTree(connId, path)
    }
  }

  const getVisibleChildren = (items: ObjectItem[]) =>
    items.filter((child) => {
      if (child.type === 'table') return treeVisibility.showTables
      if (child.type === 'view') return treeVisibility.showViews
      if (child.type === 'index') return treeVisibility.showIndexes
      return true
    })

  const submitCreateTable = async (schema: string, payload: { object: string; columns: DDLColumnInput[] }) => {
    setIsCreatingTable(true)
    try {
      await ddl(connId, {
        type: 'create_table',
        schema,
        object: payload.object,
        params: { columns: payload.columns },
      })
      await refreshTree(connId)
      pushToast({
        tone: 'success',
        title: 'Table created',
        message: `${schema}.${payload.object} is now available in the object tree.`,
      })
      setCreateTableSchema(null)
    } catch (error) {
      const message = (error as Error).message
      pushToast({ tone: 'error', title: 'Create table failed', message })
      throw error
    } finally {
      setIsCreatingTable(false)
    }
  }

  const renderPgIndexItem = (item: ObjectItem, nested = false) => (
    <button
      key={`${item.schema}.${item.name}`}
      type="button"
      onClick={() => openTab(connId, `${item.schema}.${item.name}`, 'index')}
      className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground ${nested ? 'pl-3' : ''}`}
      title={item.parent_name ? `${item.name} on ${item.parent_name}` : item.name}
    >
      {getIcon(item.type)}
      <span className="truncate">{item.name}</span>
    </button>
  )

  const renderPgLeafItem = (item: ObjectItem, childIndexes: ObjectItem[] = []) => {
    if (item.type === 'schema') {
      return null
    }

    const objectKey = `${item.schema}.${item.name}`

    return (
      <div key={objectKey}>
        <button
          type="button"
          onClick={() => openTab(connId, objectKey, item.type as ObjectType)}
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
        >
          {getIcon(item.type)}
          <span className="truncate">{item.name}</span>
          {item.row_count > 0 && (
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">{formatCount(item.row_count)}</span>
          )}
        </button>
        {item.type === 'table' && childIndexes.length > 0 && (
          <div className="ml-4 border-l border-border/70 pl-2">
            {childIndexes.map((indexItem) => renderPgIndexItem(indexItem, true))}
          </div>
        )}
      </div>
    )
  }

  const renderPgSchemaNode = (item: ObjectItem) => {
    const nodePath = item.name
    const expanded = expandedSchemas.has(buildTreeKey(connId, nodePath))
    const children = treeItems[buildTreeKey(connId, nodePath)] || []
    const visibleChildren = getVisibleChildren(children)
    const groupedChildren = groupSchemaChildren(visibleChildren, treeVisibility.showTables)
    const schemaLoading = expanded && !treeItems[buildTreeKey(connId, nodePath)] && treeLoading

    return (
      <div key={item.name}>
        <div className="group flex items-center gap-1">
          <button
            type="button"
            onClick={() => handleNodeClick(nodePath)}
            className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
          >
            {getIcon('schema', expanded)}
            <span className="truncate">{item.name}</span>
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 text-muted-foreground opacity-70 transition-opacity hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-100"
                aria-label={`Schema actions for ${item.name}`}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuLabel>Schema Actions</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => setCreateTableSchema(item.name)}>
                <Plus className="mr-2 h-3.5 w-3.5" />
                Create Table
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {expanded && (
          <div className="ml-4 border-l border-border pl-1">
            {schemaLoading && <LoadingSkeleton variant="tree" />}
            {!schemaLoading && children.length === 0 && <EmptyState variant="no_tables" compact className="mt-2" />}
            {!schemaLoading && children.length > 0 && visibleChildren.length === 0 && (
              <EmptyState
                variant="no_tables"
                compact
                className="mt-2"
                title="No visible objects"
                description="This schema has objects, but the current tree filters hide them."
              />
            )}
            {groupedChildren.primaryItems.map((child) =>
              renderPgLeafItem(child, groupedChildren.indexesByParent.get(child.name) ?? [])
            )}
            {groupedChildren.unattachedIndexes.length > 0 && (
              <div className="mt-2 space-y-1 rounded-sm border border-dashed border-border/70 bg-muted/10 px-2 py-2">
                <div className="px-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                  Unattached indexes
                </div>
                <div className="space-y-0.5">
                  {groupedChildren.unattachedIndexes.map((indexItem) => renderPgIndexItem(indexItem))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  const renderRedisLeafItem = (item: ObjectItem, nested = false) => {
    const objectKey = item.path ?? item.name
    const ttl = formatRedisTTL(item.ttl_seconds)

    return (
      <button
        key={objectKey}
        type="button"
        onClick={() => openTab(connId, objectKey, item.type as ObjectType)}
        className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted ${nested ? 'pl-3' : ''}`}
        title={objectKey}
      >
        {getIcon(item.type)}
        <span className="truncate">{item.name}</span>
        <span className="rounded-sm border border-border bg-muted/20 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
          {getObjectTypeLabel(item.type)}
        </span>
        {ttl && (
          <span
            className={`ml-auto shrink-0 rounded-sm border px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-[0.12em] ${
              ttl === 'No TTL'
                ? 'border-border bg-muted/20 text-muted-foreground'
                : item.ttl_seconds !== undefined && item.ttl_seconds > 0 && item.ttl_seconds < 300
                  ? 'border-red-500/20 bg-red-500/5 text-red-500'
                  : item.ttl_seconds !== undefined && item.ttl_seconds < 3600
                    ? 'border-amber-500/20 bg-amber-500/5 text-amber-500'
                    : 'border-emerald-500/20 bg-emerald-500/5 text-emerald-500'
            }`}
          >
            {ttl}
          </span>
        )}
      </button>
    )
  }

  const renderRedisNamespaceNode = (item: ObjectItem) => {
    const nodePath = item.path ?? item.name
    const expanded = expandedSchemas.has(buildTreeKey(connId, nodePath))
    const children = treeItems[buildTreeKey(connId, nodePath)] || []
    const nodeLoading = expanded && !treeItems[buildTreeKey(connId, nodePath)] && treeLoading

    return (
      <div key={nodePath}>
        <button
          type="button"
          onClick={() => handleNodeClick(nodePath)}
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
        >
          {getIcon('namespace', expanded)}
          <span className="truncate">{item.name}</span>
          <span className="ml-auto shrink-0 rounded-sm border border-red-500/20 bg-red-500/5 px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-[0.12em] text-red-500">
            {formatCount(item.row_count)} keys
          </span>
        </button>
        {expanded && (
          <div className="ml-4 border-l border-border pl-1">
            {nodeLoading && <LoadingSkeleton variant="tree" />}
            {!nodeLoading && children.length === 0 && (
              <EmptyState
                variant="no_tables"
                compact
                className="mt-2"
                title="No keys in namespace"
                description="This namespace currently has no loaded children."
              />
            )}
            {!nodeLoading &&
              children.map((child) =>
                isRedisNamespace(child.type) ? renderRedisNamespaceNode(child) : renderRedisLeafItem(child)
              )}
          </div>
        )}
      </div>
    )
  }

  const renderRedisItem = (item: ObjectItem) =>
    isRedisNamespace(item.type) ? renderRedisNamespaceNode(item) : renderRedisLeafItem(item)

  if (treeLoading && rootItems.length === 0) {
    return <LoadingSkeleton variant="tree" />
  }

  if (treeError && rootItems.length === 0) {
    return (
      <div className="space-y-3">
        <ErrorBanner message={treeError} onRetry={() => void fetchTree(connId)} />
        <EmptyState
          variant="no_tables"
          compact
          title={isRedisConnection ? 'Redis tree unavailable' : 'Connection unavailable'}
          description={
            isRedisConnection
              ? 'The Redis namespace tree could not be loaded. Check the Redis connector implementation and connection access.'
              : 'The object tree could not be loaded. Check the database host, credentials, and network access.'
          }
        />
      </div>
    )
  }

  if (!treeLoading && rootItems.length === 0) {
    return (
      <EmptyState
        variant="no_tables"
        compact
        title={isRedisConnection ? 'No Redis keys loaded' : undefined}
        description={isRedisConnection ? 'The Redis connector has not returned any namespace or key nodes yet.' : undefined}
      />
    )
  }

  if (!isRedisConnection && !treeLoading && rootItems.length > 0 && filteredRootItems.length === 0) {
    return (
      <EmptyState
        variant="no_tables"
        compact
        title="No schemas visible"
        description="Click the schema filter to enable one or more schemas for this connection."
      />
    )
  }

  return (
    <>
      <div className="space-y-0.5">
        {(isRedisConnection ? rootItems : filteredRootItems).map((item) =>
          isRedisConnection ? renderRedisItem(item) : renderPgSchemaNode(item)
        )}
      </div>
      {!isRedisConnection && (
        <CreateTableForm
          open={createTableSchema !== null}
          schema={createTableSchema ?? 'public'}
          saving={isCreatingTable}
          onOpenChange={(open) => {
            if (!open) {
              setCreateTableSchema(null)
            }
          }}
          onSubmit={(payload) => submitCreateTable(createTableSchema ?? 'public', payload)}
        />
      )}
    </>
  )
}
