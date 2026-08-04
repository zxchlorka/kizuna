import type { ReactNode } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

interface ConfirmDialogProps {
  open: boolean
  title: string
  description: ReactNode
  /** Verbatim text worth re-reading before confirming: the SQL about to run for
   * real, the Redis command about to block the server. Omit when there is none. */
  preview?: { label: string; content: string }
  confirmLabel: string
  /** Styles the confirm button as destructive. For actions that delete data. */
  destructive?: boolean
  /** An in-flight confirm: disables both buttons so the action cannot double-fire. */
  busy?: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

/**
 * The shared shape of every "are you sure?" in the app: title, explanation, an
 * optional verbatim preview, cancel/confirm. Four components used to spell this
 * out separately and had drifted apart — some disabled their buttons while the
 * action ran, some did not.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  preview,
  confirmLabel,
  destructive = false,
  busy = false,
  onOpenChange,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>

        {preview && (
          <div className="rounded-sm border border-border bg-muted/20 p-3">
            <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
              {preview.label}
            </p>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-foreground">
              {preview.content}
            </pre>
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={busy}
            className={destructive ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : undefined}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
