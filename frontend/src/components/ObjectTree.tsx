import { useEffect } from 'react'
import { Folder, FolderOpen, Table2, Eye, Zap, Loader2 } from 'lucide-react'
import { useWorkspaceStore } from '@/stores/workspace'
import type { ObjectItem } from '@/types/api'

interface ObjectTreeProps {
  connId: string
}

export function ObjectTree({ connId }: ObjectTreeProps) {
  const { treeItems, treeLoading, expandedSchemas, fetchTree, toggleSchema, openTab } =
    useWorkspaceStore()

  useEffect(() => {
    fetchTree(connId)
  }, [connId, fetchTree])

  const rootItems = treeItems[''] || []

  const handleSchemaClick = (schema: string) => {
    toggleSchema(schema)
    if (!expandedSchemas.has(schema) && !treeItems[schema]) {
      fetchTree(connId, schema)
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

  const renderItem = (item: ObjectItem) => {
    if (item.type === 'schema') {
      const expanded = expandedSchemas.has(item.name)
      const children = treeItems[item.name] || []
      const schemaLoading = expanded && !treeItems[item.name] && treeLoading

      return (
        <div key={item.name}>
          <button
            onClick={() => handleSchemaClick(item.name)}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
          >
            {getIcon('schema', expanded)}
            <span className="truncate">{item.name}</span>
          </button>
          {expanded && (
            <div className="ml-4 border-l border-border pl-1">
              {schemaLoading && (
                <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" /> Loading...
                </div>
              )}
              {children.map((child) => renderItem(child))}
            </div>
          )}
        </div>
      )
    }

    return (
      <button
        key={`${item.schema}.${item.name}`}
        onClick={() => openTab(connId, `${item.schema}.${item.name}`)}
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
    )
  }

  if (treeLoading && rootItems.length === 0) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return <div className="space-y-0.5">{rootItems.map(renderItem)}</div>
}
