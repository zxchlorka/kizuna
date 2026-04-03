import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { AlertTriangle, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content className="fixed inset-0 z-50 m-auto h-fit w-full max-w-lg rounded-sm border border-destructive/30 bg-background shadow-2xl">
          <form onSubmit={handleConfirm}>
            <div className="flex items-center justify-between border-b border-border px-6 py-4">
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-sm border border-destructive/30 bg-destructive/10 text-destructive">
                  <AlertTriangle className="h-4 w-4" />
                </div>
                <div>
                  <Dialog.Title className="font-mono text-sm font-semibold">{title}</Dialog.Title>
                  <p className="mt-1 text-xs text-muted-foreground">{description}</p>
                </div>
              </div>
              <Dialog.Close className="rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
                <X className="h-4 w-4" />
              </Dialog.Close>
            </div>
            <div className="space-y-4 px-6 py-5">
              <div className="rounded-sm border border-destructive/30 bg-destructive/10 px-3 py-3 text-xs text-destructive">
                This action cannot be undone.
              </div>
              {choices && choices.length > 0 && (
                <div>
                  <label className="mb-1 block text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                    {targetLabel}
                  </label>
                  <Select value={selectedTarget} onValueChange={setSelectedTarget}>
                    <SelectTrigger className="h-10 w-full text-xs font-mono">
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
                <input className="w-full rounded-sm border border-input bg-background px-3 py-2 text-sm font-mono outline-none focus:border-destructive/60" value={value} onChange={(event) => setValue(event.target.value)} placeholder={confirmTarget} />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-4">
              <Button type="button" variant="outline" size="sm" className="h-8 px-3" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="destructive" size="sm" className="h-8 px-3" disabled={!canConfirm || saving}>
                {saving ? 'Deleting…' : 'Delete'}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
