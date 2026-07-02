import { useEffect, useState } from 'react'
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
import { Input } from '@/components/ui/input'

interface DeleteKeyDialogProps {
  open: boolean
  keyName: string
  deleting: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => Promise<void> | void
}

export function DeleteKeyDialog({ open, keyName, deleting, onOpenChange, onConfirm }: DeleteKeyDialogProps) {
  const [confirmation, setConfirmation] = useState('')

  useEffect(() => {
    if (open) {
      setConfirmation('')
    }
  }, [open])

  const matches = confirmation.trim() === keyName

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-md border border-destructive/20 bg-destructive/10 text-destructive">
              <AlertTriangle className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <DialogTitle className="font-mono text-sm">Delete Key</DialogTitle>
              <DialogDescription className="truncate font-mono text-[11px] text-muted-foreground">
                {keyName}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            This permanently deletes the selected Redis key. Type the exact key name to confirm.
          </p>
          <Input
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            placeholder={keyName}
            className="font-mono"
          />
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" size="sm" onClick={() => void onConfirm()} disabled={!matches || deleting}>
            {deleting ? 'Deleting…' : 'Delete key'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
