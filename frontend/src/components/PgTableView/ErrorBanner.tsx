import { X } from 'lucide-react'

interface ErrorBannerProps {
  message: string
  onDismiss: () => void
}

export function ErrorBanner({ message, onDismiss }: ErrorBannerProps) {
  return (
    <div className="mx-2 mt-2 flex items-center justify-between rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      <span>{message}</span>
      <button type="button" onClick={onDismiss} className="rounded p-1 hover:bg-destructive/20">
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}
