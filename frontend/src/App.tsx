import { Routes, Route } from 'react-router-dom'
import ConnectionListPage from '@/pages/ConnectionListPage'
import DataViewPage from '@/pages/DataViewPage'
import SettingsPage from '@/pages/SettingsPage'
import { ToastViewport } from '@/components/ToastViewport'

export default function App() {
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
