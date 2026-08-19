import { Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { clipboardFailureMessage, writeClipboardText } from '@/lib/clipboard'
import { availableStatements, buildRowStatement, type RowStatementKind } from '@/lib/rowSql'
import { cn } from '@/lib/utils'
import { useToastStore } from '@/stores/toast'
import type { ColumnMeta, TableRow } from '@/types/api'

const STATEMENT_LABELS: Record<RowStatementKind, string> = {
  select: 'SELECT',
  insert: 'INSERT',
  update: 'UPDATE',
  delete: 'DELETE',
}

interface RowCardDialogProps {
  open: boolean
  columns: ColumnMeta[]
  row: TableRow | null
  title: string
  onOpenChange: (open: boolean) => void
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'object') return JSON.stringify(value, null, 2)
  return String(value)
}

// One record read top to bottom instead of scrolled left to right. A wide table
// puts a single row past the edge of the screen, and by the time you have
// scrolled to a column you can no longer see which row you are on.
export function RowCardDialog({ open, columns, row, title, onOpenChange }: RowCardDialogProps) {
  const pushToast = useToastStore((state) => state.push)

  const copyValue = async (value: unknown) => {
    const ok = await writeClipboardText(renderValue(value))
    if (!ok) {
      pushToast({ tone: 'error', title: 'Copy failed', message: clipboardFailureMessage() })
    }
  }

  const statements = row ? availableStatements(columns, row) : []
  const keyless = statements.length > 0 && !statements.includes('delete')

  const copyStatement = async (kind: RowStatementKind) => {
    if (!row) {
      return
    }
    const statement = buildRowStatement(kind, title, columns, row)
    if (!statement) {
      return
    }
    const ok = await writeClipboardText(statement)
    pushToast(
      ok
        ? { tone: 'success', title: `${STATEMENT_LABELS[kind]} copied`, message: title }
        : { tone: 'error', title: 'Copy failed', message: clipboardFailureMessage() }
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">{title}</DialogTitle>
          <DialogDescription className="font-mono text-xs">
            Every column of one row. NULL is shown as itself, so an empty string is never mistaken for a missing value.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto rounded-sm border border-border">
          <table className="w-full font-mono text-xs">
            <tbody>
              {row &&
                columns.map((column) => {
                  const value = row[column.name]
                  return (
                    <tr key={column.name} className="group border-b border-border/50 last:border-b-0">
                      <td className="w-1/3 min-w-0 px-3 py-2 align-top text-muted-foreground">
                        <span className="break-all">{column.name}</span>
                        <span className="ml-2 text-[10px] uppercase tracking-[0.12em] opacity-60">
                          {column.data_type}
                        </span>
                      </td>
                      <td
                        className={cn(
                          'whitespace-pre-wrap break-all px-3 py-2 align-top',
                          value === null || value === undefined ? 'text-muted-foreground/60 italic' : ''
                        )}
                      >
                        {renderValue(value)}
                      </td>
                      <td className="w-9 px-1 py-2 align-top">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-6 w-6 p-0 opacity-0 transition-opacity group-hover:opacity-100"
                          onClick={() => void copyValue(value)}
                          title={`Copy ${column.name}`}
                          aria-label={`Copy ${column.name}`}
                        >
                          <Copy className="h-3 w-3" />
                        </Button>
                      </td>
                    </tr>
                  )
                })}
            </tbody>
          </table>
        </div>

        {row && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Copy as</span>
            {statements.map((kind) => (
              <Button
                key={kind}
                type="button"
                size="sm"
                variant="outline"
                className="h-7 px-3 font-mono text-[11px]"
                onClick={() => void copyStatement(kind)}
              >
                {STATEMENT_LABELS[kind]}
              </Button>
            ))}
            {keyless && (
              <span className="text-[11px] text-muted-foreground">
                UPDATE and DELETE need a primary key — without one a statement could match rows other than
                this.
              </span>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
