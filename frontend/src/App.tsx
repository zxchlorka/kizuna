import { Routes, Route } from 'react-router-dom'
import ConnectionListPage from '@/pages/ConnectionListPage'
import DataViewPage from '@/pages/DataViewPage'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<ConnectionListPage />} />
      <Route path="/connections/:id" element={<DataViewPage />} />
    </Routes>
  )
}
