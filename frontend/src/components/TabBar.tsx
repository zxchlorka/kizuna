import { Eye, Table2, X, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useWorkspaceStore } from '@/stores/workspace'

function tabIcon(type: 'table' | 'view' | 'index') {
  if (type === 'view') {
    return <Eye className="h-3.5 w-3.5 text-purple-500" />
  }
  if (type === 'index') {
    return <Zap className="h-3.5 w-3.5 text-yellow-500" />
  }
  return <Table2 className="h-3.5 w-3.5 text-blue-500" />
}

export function TabBar() {
  const { tabs, activeTabId, setActiveTab, closeTab } = useWorkspaceStore()

  return (
    <div className="flex min-h-[36px] items-center gap-0 overflow-x-auto border-b border-border bg-muted/30">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          onClick={() => setActiveTab(tab.id)}
          className={cn(
            'group flex shrink-0 cursor-pointer items-center gap-1.5 border-r border-border px-3 py-2 text-sm',
            tab.id === activeTabId
              ? 'bg-background text-foreground border-b-2 border-b-primary'
              : 'text-muted-foreground hover:bg-background/50 hover:text-foreground'
          )}
        >
          {tabIcon(tab.objectType)}
          <span className="max-w-[120px] truncate">{tab.label}</span>
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
  )
}
