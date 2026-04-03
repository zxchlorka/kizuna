import { AlertTriangle } from 'lucide-react'

interface ProductionBannerProps {
  visible: boolean
}

export function ProductionBanner({ visible }: ProductionBannerProps) {
  if (!visible) {
    return null
  }

  return (
    <div className="sticky top-0 z-40 flex items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-xs font-medium text-amber-500 backdrop-blur">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      <span>Production environment. DDL and write operations affect live data.</span>
    </div>
  )
}
