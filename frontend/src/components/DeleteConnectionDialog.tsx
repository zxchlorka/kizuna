import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface DeleteConnectionDialogProps {
  open: boolean
  connectionName: string
  deleting: boolean
  // Number of cross-source links that will be removed with this connection, when
  // the links store already knows. Undefined means "not loaded" — the count is an
  // enhancement, never a precondition for the delete.
  linkCount?: number
  onOpenChange: (open: boolean) => void
  onConfirm: () => Promise<void> | void
}

export function DeleteConnectionDialog({
  open,
  connectionName,
  deleting,
  linkCount,
  onOpenChange,
  onConfirm,
}: DeleteConnectionDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md border-border bg-background">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-sm border border-destructive/25 bg-destructive/10 text-destructive">
              <AlertTriangle className="h-4.5 w-4.5" />
            </div>
            <div className="min-w-0">
              <DialogTitle className="font-mono text-sm uppercase tracking-[0.12em] text-foreground">
                Delete connection
              </DialogTitle>
              <DialogDescription className="mt-2 text-sm leading-6 text-muted-foreground">
                This deletes the saved connection{' '}
                <span className="font-mono text-foreground">{connectionName}</span>, its open tabs, and all
                cross-source links where it is a source or target.
                {linkCount !== undefined && linkCount > 0 && (
                  <span className="mt-2 block font-mono text-[11px] text-amber-600 dark:text-amber-400">
                    {linkCount} {linkCount === 1 ? 'link' : 'links'} will also be removed
                  </span>
                )}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={deleting}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" size="sm" onClick={() => void onConfirm()} disabled={deleting}>
            {deleting ? 'Deleting...' : 'Delete'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
