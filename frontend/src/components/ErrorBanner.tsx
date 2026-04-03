import { AlertTriangle, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface ErrorBannerProps {
  message: string
  onRetry?: () => void
  onDismiss?: () => void
}

export function ErrorBanner({ message, onRetry, onDismiss }: ErrorBannerProps) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-sm border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      <div className="flex min-w-0 items-center gap-2">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{message}</span>
      </div>
      <div className="flex items-center gap-1">
        {onRetry && (
          <Button variant="outline" size="sm" className="h-7 gap-1 border-destructive/30 text-destructive hover:bg-destructive/10" onClick={onRetry}>
            <RefreshCw className="h-3 w-3" />
            Retry
          </Button>
        )}
        {onDismiss && (
          <button type="button" className="rounded p-1 hover:bg-destructive/10" onClick={onDismiss}>
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  )
}
