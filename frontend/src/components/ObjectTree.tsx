import { useEffect, useMemo, useState } from 'react'
import { Eye, Folder, FolderOpen, MoreHorizontal, Plus, Table2, Zap } from 'lucide-react'
import { CreateTableForm } from '@/components/DDL/CreateTableForm'
import { EmptyState } from '@/components/EmptyState'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useDataStore } from '@/stores/data'
import { useToastStore } from '@/stores/toast'
import { useWorkspaceStore } from '@/stores/workspace'
import type { DDLColumnInput, ObjectItem } from '@/types/api'

interface SchemaChildGroup {
  primaryItems: ObjectItem[]
  indexesByParent: Map<string, ObjectItem[]>
  unattachedIndexes: ObjectItem[]
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

interface ObjectTreeProps {
  connId: string
}

export function ObjectTree({ connId }: ObjectTreeProps) {
  const treeItems = useWorkspaceStore((state) => state.treeItems)
  const treeLoading = useWorkspaceStore((state) => state.treeLoading)
  const expandedSchemas = useWorkspaceStore((state) => state.expandedSchemas)
  const treeVisibility = useWorkspaceStore((state) => state.treeVisibility)
  const fetchTree = useWorkspaceStore((state) => state.fetchTree)
  const refreshTree = useWorkspaceStore((state) => state.refreshTree)
  const toggleSchema = useWorkspaceStore((state) => state.toggleSchema)
  const openTab = useWorkspaceStore((state) => state.openTab)
  const ddl = useDataStore((state) => state.ddl)
  const pushToast = useToastStore((state) => state.push)
  const [createTableSchema, setCreateTableSchema] = useState<string | null>(null)
  const [isCreatingTable, setIsCreatingTable] = useState(false)

  useEffect(() => {
    void fetchTree(connId)
  }, [connId, fetchTree])

  const rootItems = treeItems[''] || []
  const schemaEmptyState = useMemo(
    () => ({
      title: 'No visible objects',
      description: 'This schema has objects, but the current tree filters hide them.',
    }),
    []
  )

  const handleSchemaClick = (schema: string) => {
    toggleSchema(schema)
    if (!expandedSchemas.has(schema) && !treeItems[schema]) {
      void fetchTree(connId, schema)
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

  const getIcon = (type: string, expanded?: boolean) => {
    switch (type) {
      case 'schema':
        return expanded ? (
          <FolderOpen className="h-4 w-4 text-[hsl(var(--accent))]" />
        ) : (
          <Folder className="h-4 w-4 text-muted-foreground" />
        )
      case 'table':
        return <Table2 className="h-4 w-4 text-blue-500" />
      case 'view':
        return <Eye className="h-4 w-4 text-purple-500" />
      case 'index':
        return <Zap className="h-4 w-4 text-yellow-500" />
      default:
        return <Table2 className="h-4 w-4 text-muted-foreground" />
    }
  }

  const formatCount = (n: number) => {
    if (n >= 1000000) return `~${(n / 1000000).toFixed(1)}M`
    if (n >= 1000) return `~${(n / 1000).toFixed(0)}K`
    return `${n}`
  }

  const renderIndexItem = (item: ObjectItem, nested = false) => (
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

  const renderLeafItem = (item: ObjectItem) => {
    if (item.type === 'schema') {
      return null
    }

    const objectKey = `${item.schema}.${item.name}`
    const objectType = item.type
    const childIndexes = item.type === 'table' ? schemaChildIndexes.get(item.name) ?? [] : []

    return (
      <div key={objectKey}>
        <button
          type="button"
          onClick={() => openTab(connId, objectKey, objectType)}
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
        >
          {getIcon(item.type)}
          <span className="truncate">{item.name}</span>
          {item.row_count > 0 && (
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">
              {formatCount(item.row_count)}
            </span>
          )}
        </button>
        {item.type === 'table' && childIndexes.length > 0 && (
          <div className="ml-4 border-l border-border/70 pl-2">
            {childIndexes.map((indexItem) => renderIndexItem(indexItem, true))}
          </div>
        )}
      </div>
    )
  }

  let schemaChildIndexes = new Map<string, ObjectItem[]>()

  const renderItem = (item: ObjectItem) => {
    if (item.type === 'schema') {
      const expanded = expandedSchemas.has(item.name)
      const children = treeItems[item.name] || []
      const visibleChildren = getVisibleChildren(children)
      const groupedChildren = groupSchemaChildren(visibleChildren, treeVisibility.showTables)
      schemaChildIndexes = groupedChildren.indexesByParent
      const schemaLoading = expanded && !treeItems[item.name] && treeLoading

      return (
        <div key={item.name}>
          <div className="group flex items-center gap-1">
            <button
              onClick={() => handleSchemaClick(item.name)}
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
              {schemaLoading && (
                <LoadingSkeleton variant="tree" />
              )}
              {!schemaLoading && children.length === 0 && <EmptyState variant="no_tables" compact className="mt-2" />}
              {!schemaLoading && children.length > 0 && visibleChildren.length === 0 && (
                <EmptyState
                  variant="no_tables"
                  compact
                  className="mt-2"
                  title={schemaEmptyState.title}
                  description={schemaEmptyState.description}
                />
              )}
              {groupedChildren.primaryItems.map((child) => renderLeafItem(child))}
              {groupedChildren.unattachedIndexes.length > 0 && (
                <div className="mt-2 space-y-1 rounded-sm border border-dashed border-border/70 bg-muted/10 px-2 py-2">
                  <div className="px-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                    Unattached indexes
                  </div>
                  <div className="space-y-0.5">
                    {groupedChildren.unattachedIndexes.map((indexItem) => renderIndexItem(indexItem))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )
    }
    return renderLeafItem(item)
  }

  if (treeLoading && rootItems.length === 0) {
    return <LoadingSkeleton variant="tree" />
  }

  if (!treeLoading && rootItems.length === 0) {
    return <EmptyState variant="no_tables" compact />
  }

  return (
    <>
      <div className="space-y-0.5">{rootItems.map(renderItem)}</div>
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
    </>
  )
}
