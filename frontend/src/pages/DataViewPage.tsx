import { useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { Sidebar } from '@/components/Sidebar'
import { TabBar } from '@/components/TabBar'
import { EmptyState } from '@/components/EmptyState'
import { ProductionBanner } from '@/components/ProductionBanner'
import { useConnectionStore } from '@/stores/connections'
import { useWorkspaceStore } from '@/stores/workspace'
import { IndexInspectorView } from '@/components/IndexInspectorView'
import { PgTableView } from '@/components/PgTableView'

export default function DataViewPage() {
  const { id } = useParams<{ id: string }>()
  const connections = useConnectionStore((state) => state.connections)
  const fetchConnections = useConnectionStore((state) => state.fetch)
  const { tabs, activeTabId } = useWorkspaceStore()
  const activeTab = tabs.find((t) => t.id === activeTabId)
  const currentConnection = connections.find((connection) => connection.id === id)

  useEffect(() => {
    if (connections.length === 0) {
      void fetchConnections()
    }
  }, [connections.length, fetchConnections])

  if (!id) return null

  return (
    <div className="flex h-screen bg-background">
      <Sidebar connId={id} />

      <div className="flex flex-1 flex-col overflow-hidden">
        <ProductionBanner visible={Boolean(currentConnection?.tags?.includes('production'))} />
        <TabBar />

        <div className="flex flex-1 overflow-hidden">
          {activeTab ? (
            activeTab.objectType === 'index' ? (
              <IndexInspectorView
                connId={activeTab.connId}
                object={activeTab.object}
                tabId={activeTab.id}
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
                  title="Select a table"
                  description="Choose a table from the object tree to inspect rows, run DDL actions, and edit data."
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
