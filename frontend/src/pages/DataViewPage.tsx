import { useParams } from 'react-router-dom'
import { Table2 } from 'lucide-react'
import { Sidebar } from '@/components/Sidebar'
import { TabBar } from '@/components/TabBar'
import { useWorkspaceStore } from '@/stores/workspace'
import { PgTableView } from '@/components/PgTableView'

export default function DataViewPage() {
  const { id } = useParams<{ id: string }>()
  const { tabs, activeTabId } = useWorkspaceStore()
  const activeTab = tabs.find((t) => t.id === activeTabId)

  if (!id) return null

  return (
    <div className="flex h-screen bg-background">
      <Sidebar connId={id} />

      <div className="flex flex-1 flex-col overflow-hidden">
        <TabBar />

        <div className="flex flex-1 overflow-hidden">
          {activeTab ? (
            <PgTableView
              connId={activeTab.connId}
              object={activeTab.object}
              tabId={activeTab.id}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center">
              <div className="text-center text-muted-foreground">
                <Table2 className="mx-auto mb-2 h-8 w-8 opacity-40" />
                <p className="text-sm">Select a table from the object tree</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
