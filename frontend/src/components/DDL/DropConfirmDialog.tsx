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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

interface DropConfirmDialogProps {
  open: boolean
  title: string
  description: string
  targetLabel: string
  expectedValue: string
  choices?: string[]
  saving: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (target: string) => Promise<void> | void
}

export function DropConfirmDialog({
  open,
  title,
  description,
  targetLabel,
  expectedValue,
  choices,
  saving,
  onOpenChange,
  onConfirm,
}: DropConfirmDialogProps) {
  const [value, setValue] = useState('')
  const [selectedTarget, setSelectedTarget] = useState(expectedValue)

  useEffect(() => {
    setSelectedTarget(expectedValue)
    if (!open) {
      setValue('')
    }
  }, [expectedValue, open])

  const confirmTarget = choices && choices.length > 0 ? selectedTarget : expectedValue
  const canConfirm = confirmTarget.trim() !== '' && value.trim() === confirmTarget

  const handleConfirm = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!canConfirm) return
    await onConfirm(confirmTarget)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-destructive/30">
        <form onSubmit={handleConfirm} className="space-y-4">
          <DialogHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-destructive/30 bg-destructive/10 text-destructive">
                <AlertTriangle className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <DialogTitle className="font-mono text-sm font-semibold">{title}</DialogTitle>
                <DialogDescription className="mt-1 text-xs">{description}</DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="rounded-sm border border-destructive/30 bg-destructive/10 px-3 py-3 text-xs text-destructive">
            This action cannot be undone.
          </div>

          {choices && choices.length > 0 && (
            <div>
              <label className="mb-1 block text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                {targetLabel}
              </label>
              <Select value={selectedTarget} onValueChange={setSelectedTarget}>
                <SelectTrigger className="h-10 w-full font-mono text-xs">
                  <SelectValue placeholder={`Select ${targetLabel.toLowerCase()}`} />
                </SelectTrigger>
                <SelectContent>
                  {choices.map((choice) => (
                    <SelectItem key={choice} value={choice}>
                      {choice}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              Type {targetLabel} to confirm
            </label>
            <Input
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={confirmTarget}
              className="font-mono focus:border-destructive/60"
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" size="sm" className="h-8 px-3" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" size="sm" className="h-8 px-3" disabled={!canConfirm || saving}>
              {saving ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
