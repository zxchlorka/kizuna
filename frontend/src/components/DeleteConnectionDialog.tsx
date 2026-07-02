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
  onOpenChange: (open: boolean) => void
  onConfirm: () => Promise<void> | void
}

export function DeleteConnectionDialog({
  open,
  connectionName,
  deleting,
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
                This removes <span className="font-mono text-foreground">{connectionName}</span> from Kizuna. The
                saved access settings for this connection will be deleted.
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
