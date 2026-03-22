import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, PanelLeftClose, PanelLeft } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ObjectTree } from '@/components/ObjectTree'

interface SidebarProps {
  connId: string
}

export function Sidebar({ connId }: SidebarProps) {
  const navigate = useNavigate()
  const [collapsed, setCollapsed] = useState(false)

  return (
    <div
      className={cn(
        'flex h-full flex-col border-r border-border bg-background transition-all',
        collapsed ? 'w-10' : 'w-60'
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border p-2">
        {!collapsed && (
          <button
            onClick={() => navigate('/')}
            className="flex items-center gap-1 rounded px-1.5 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            <span>Back</span>
          </button>
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
          <ObjectTree connId={connId} />
        </div>
      )}
    </div>
  )
}
