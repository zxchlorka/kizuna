import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useToastStore } from '@/stores/toast'

const toneStyles = {
  success: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500',
  error: 'border-destructive/30 bg-destructive/10 text-destructive',
  info: 'border-border bg-card text-foreground',
} as const

const toneIcons = {
  success: CheckCircle2,
  error: AlertTriangle,
  info: Info,
} as const

export function ToastViewport() {
  const toasts = useToastStore((state) => state.toasts)
  const dismiss = useToastStore((state) => state.dismiss)

  if (toasts.length === 0) {
    return null
  }

  return (
    <div className="pointer-events-none fixed right-4 top-4 z-[70] flex w-full max-w-sm flex-col gap-2">
      {toasts.map((toast) => {
        const Icon = toneIcons[toast.tone]
        return (
          <div
            key={toast.id}
            className={cn(
              'pointer-events-auto rounded-sm border px-3 py-3 shadow-lg backdrop-blur',
              toneStyles[toast.tone]
            )}
          >
            <div className="flex items-start gap-3">
              <Icon className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="font-mono text-xs font-semibold">{toast.title}</p>
                {toast.message && <p className="mt-1 text-xs opacity-90">{toast.message}</p>}
              </div>
              <button
                type="button"
                className="rounded-sm p-1 opacity-70 transition-opacity hover:opacity-100"
                onClick={() => dismiss(toast.id)}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
