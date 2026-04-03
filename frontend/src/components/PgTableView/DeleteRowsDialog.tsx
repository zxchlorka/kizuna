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

interface DeleteRowsDialogProps {
  open: boolean
  object: string
  selectedCount: number
  saving: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

export function DeleteRowsDialog({
  open,
  object,
  selectedCount,
  saving,
  onOpenChange,
  onConfirm,
}: DeleteRowsDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete selected rows?</AlertDialogTitle>
          <AlertDialogDescription>
            This action cannot be undone. {selectedCount} {selectedCount === 1 ? 'row' : 'rows'} will be deleted from{' '}
            <span className="font-mono">{object}</span>.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={saving}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
