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

interface SaveChangesDialogProps {
  open: boolean
  saving: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

export function SaveChangesDialog({ open, saving, onOpenChange, onConfirm }: SaveChangesDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Apply pending changes?</AlertDialogTitle>
          <AlertDialogDescription>
            Changes will be written to the database in a single bulk transaction.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} disabled={saving}>
            Apply changes
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
