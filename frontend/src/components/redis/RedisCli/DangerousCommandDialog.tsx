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

interface DangerousCommandDialogProps {
  open: boolean
  command: string
  statement: string
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

export function DangerousCommandDialog({
  open,
  command,
  statement,
  onOpenChange,
  onConfirm,
}: DangerousCommandDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Run {command}?</AlertDialogTitle>
          <AlertDialogDescription>
            {command === 'KEYS'
              ? 'KEYS scans the entire keyspace in a single blocking call. On a large database it can freeze the Redis server for a long time. Prefer SCAN with a pattern.'
              : 'This command can block the Redis server or destroy data. Make sure you understand its impact before running it.'}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="rounded-sm border border-border bg-muted/20 p-3">
          <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            Command Preview
          </p>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-foreground">
            {statement.trim()}
          </pre>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Run anyway</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
