import { useEffect } from 'react'
import { Routes, Route } from 'react-router-dom'
import ConnectionListPage from '@/pages/ConnectionListPage'
import DataViewPage from '@/pages/DataViewPage'
import SettingsPage from '@/pages/SettingsPage'
import { ToastViewport } from '@/components/ToastViewport'
import { restoreWorkspace, syncWorkspaceWithConnections } from '@/lib/workspacePersistence'
import { useConnectionStore } from '@/stores/connections'

// Runs once when this module first loads (module-scope code executes exactly
// once, before the first render), so restored tabs are present on the first
// paint instead of popping in a moment after an empty state — see
// restoreWorkspace's own comment for why this can't wait for a connection
// fetch or be deferred into a component effect.
restoreWorkspace()

export default function App() {
  const connections = useConnectionStore((state) => state.connections)
  const connectionsLoadedOnce = useConnectionStore((state) => state.loadedOnce)
  const connectionsError = useConnectionStore((state) => state.error)

  // Deferred to an effect (unlike restoreWorkspace above) because it needs the
  // real connection list, which only exists once some page's fetch resolves.
  // Neither page is guaranteed to be the one mounted first, so this lives here
  // rather than in ConnectionListPage/DataViewPage individually. When it is safe
  // to actually prune is decided inside syncWorkspaceWithConnections.
  useEffect(() => {
    syncWorkspaceWithConnections({
      loadedOnce: connectionsLoadedOnce,
      error: connectionsError,
      connIds: connections.map((connection) => connection.id),
    })
  }, [connectionsLoadedOnce, connectionsError, connections])

  return (
    <>
      <Routes>
        <Route path="/" element={<ConnectionListPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/connections/:id" element={<DataViewPage />} />
      </Routes>
      <ToastViewport />
    </>
  )
}
