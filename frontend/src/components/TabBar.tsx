import { Eye, Plus, SquareTerminal, Table2, X, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useWorkspaceStore } from '@/stores/workspace'

interface TabBarProps {
  connId: string
}

function tabIcon(kind: 'sql' | 'table' | 'view' | 'index') {
  if (kind === 'sql') {
    return <SquareTerminal className="h-3.5 w-3.5 text-amber-500" />
  }
  if (kind === 'view') {
    return <Eye className="h-3.5 w-3.5 text-purple-500" />
  }
  if (kind === 'index') {
    return <Zap className="h-3.5 w-3.5 text-yellow-500" />
  }
  return <Table2 className="h-3.5 w-3.5 text-blue-500" />
}

export function TabBar({ connId }: TabBarProps) {
  const { tabs, activeTabId, setActiveTab, closeTab, openSqlTab } = useWorkspaceStore()

  return (
    <div className="flex min-h-[42px] items-center justify-between gap-2 border-b border-border bg-muted/30 pr-2">
      <div className="flex min-h-[42px] flex-1 items-center gap-0 overflow-x-auto">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              'group flex shrink-0 cursor-pointer items-center gap-1.5 border-r border-border px-3 py-2 text-sm',
              tab.id === activeTabId
                ? 'border-b-2 border-b-primary bg-background text-foreground'
                : 'text-muted-foreground hover:bg-background/50 hover:text-foreground'
            )}
          >
            {tabIcon(tab.kind === 'sql' ? 'sql' : tab.objectType)}
            <span className="max-w-[140px] truncate">{tab.label}</span>
            <button
              onClick={(e) => {
                e.stopPropagation()
                closeTab(tab.id)
              }}
              className="ml-1 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-muted"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-8 shrink-0 gap-1.5 font-mono text-[11px]"
        onClick={() => openSqlTab(connId)}
      >
        <Plus className="h-3.5 w-3.5" />
        New SQL
      </Button>
    </div>
  )
}
