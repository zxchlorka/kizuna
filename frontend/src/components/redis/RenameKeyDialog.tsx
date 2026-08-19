import { useEffect, useState } from 'react'
import { PenLine, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

interface RenameKeyDialogProps {
  open: boolean
  keyName: string
  saving: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (name: string) => Promise<void> | void
}

export function RenameKeyDialog({ open, keyName, saving, onOpenChange, onConfirm }: RenameKeyDialogProps) {
  const [name, setName] = useState(keyName)

  useEffect(() => {
    if (open) {
      setName(keyName)
    }
  }, [keyName, open])

  const trimmed = name.trim()
  const unchanged = trimmed === keyName

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!trimmed || unchanged || saving) {
      return
    }
    await onConfirm(trimmed)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <form onSubmit={handleSubmit} className="space-y-5">
          <DialogHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-md border border-amber-500/20 bg-amber-500/10 text-amber-500">
                <PenLine className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <DialogTitle className="font-mono text-sm">Rename key</DialogTitle>
                <DialogDescription className="truncate font-mono text-[11px] text-muted-foreground">
                  {keyName}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="space-y-2">
            <label className="block text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              New name
            </label>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="profile:1234"
              className="font-mono"
              aria-label="New key name"
              autoFocus
            />
            <p className="text-[11px] text-muted-foreground">
              A name already in use is refused rather than overwritten. The value and its TTL move with
              the key.
            </p>
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" size="sm" className="h-8 px-3">
                <X className="h-3.5 w-3.5" />
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" size="sm" className="h-8 px-3" disabled={saving || !trimmed || unchanged}>
              {saving ? 'Renaming…' : 'Rename'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
