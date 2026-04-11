import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Eye, PanelLeftClose, PanelLeft, Settings, SlidersHorizontal, Table2, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { ObjectTree } from '@/components/ObjectTree'
import { useConnectionStore } from '@/stores/connections'
import { useWorkspaceStore, type TreeVisibilityKey } from '@/stores/workspace'

interface SidebarProps {
  connId: string
}

export function Sidebar({ connId }: SidebarProps) {
  const navigate = useNavigate()
  const [collapsed, setCollapsed] = useState(false)
  const connection = useConnectionStore((state) => state.connections.find((item) => item.id === connId))
  const treeVisibility = useWorkspaceStore((state) => state.treeVisibility)
  const setTreeVisibility = useWorkspaceStore((state) => state.setTreeVisibility)

  const filters: Array<{ key: TreeVisibilityKey; label: string; icon: typeof Table2 }> = [
    { key: 'showTables', label: 'Tables', icon: Table2 },
    { key: 'showViews', label: 'Views', icon: Eye },
    { key: 'showIndexes', label: 'Indexes', icon: Zap },
  ]

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
          {connection?.type === 'redis' ? (
            <div className="mb-3 rounded-sm border border-border bg-muted/10 p-2">
              <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                <SlidersHorizontal className="h-3.5 w-3.5" />
                Redis tree
              </div>
              <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
                Redis namespaces and typed keys are shown directly. Tree filters for relational objects are hidden here.
              </p>
            </div>
          ) : (
            <div className="mb-3 rounded-sm border border-border bg-muted/10 p-2">
              <div className="mb-2 flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                <SlidersHorizontal className="h-3.5 w-3.5" />
                Tree Filters
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
          <ObjectTree connId={connId} />
        </div>
      )}
    </div>
  )
}
