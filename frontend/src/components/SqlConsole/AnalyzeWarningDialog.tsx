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

interface AnalyzeWarningDialogProps {
  open: boolean
  statement: string
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

export function AnalyzeWarningDialog({
  open,
  statement,
  onOpenChange,
  onConfirm,
}: AnalyzeWarningDialogProps) {
  const preview = statement.trim()

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Run EXPLAIN ANALYZE?</AlertDialogTitle>
          <AlertDialogDescription>
            This mode executes the query for real. For INSERT, UPDATE, DELETE, or DDL statements it can
            change data. For heavy SELECT queries it can take time and load the database.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="rounded-sm border border-border bg-muted/20 p-3">
          <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            Query Preview
          </p>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-foreground">
            {preview}
          </pre>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Run Analyze</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
