import { AlertTriangle, Loader2, Trash2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface BulkDeleteDialogProps {
  open: boolean
  pattern: string
  previewCount: number | null
  previewing: boolean
  deleting: boolean
  onPatternChange: (value: string) => void
  onPreview: () => void
  onDelete: () => void
  onOpenChange: (open: boolean) => void
}

export function BulkDeleteDialog({
  open,
  pattern,
  previewCount,
  previewing,
  deleting,
  onPatternChange,
  onPreview,
  onDelete,
  onOpenChange,
}: BulkDeleteDialogProps) {
  const isGlobalPattern = pattern.trim() === '*'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">Bulk Delete Keys</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Preview the match count first, then run a batched delete against the current Redis connection.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <label className="block text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Pattern</label>
            <Input value={pattern} onChange={(event) => onPatternChange(event.target.value)} className="font-mono" placeholder="cache:*" />
          </div>

          {isGlobalPattern && (
            <div className="rounded-sm border border-destructive/30 bg-destructive/10 px-3 py-3 text-sm text-destructive">
              <div className="flex items-center gap-2 font-medium">
                <AlertTriangle className="h-4 w-4" />
                This will delete all keys in the selected Redis database.
              </div>
            </div>
          )}

          <div className="rounded-sm border border-border bg-muted/30 px-3 py-3 text-sm text-muted-foreground">
            {previewCount === null ? 'Run preview to count matching keys.' : `Preview matched ${previewCount} key(s).`}
          </div>

          {deleting && (
            <div className="space-y-2">
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div className="h-full w-1/3 animate-pulse rounded-full bg-destructive" />
              </div>
              <div className="text-xs text-muted-foreground">Deleting matched keys in batches…</div>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" className="gap-1.5 font-mono text-[11px]" disabled={previewing || deleting} onClick={onPreview}>
            {previewing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Preview
          </Button>
          <Button type="button" variant="destructive" className="gap-1.5 font-mono text-[11px]" disabled={deleting || previewCount === null || previewCount === 0} onClick={onDelete}>
            {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            Delete {previewCount ?? 0} keys
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
