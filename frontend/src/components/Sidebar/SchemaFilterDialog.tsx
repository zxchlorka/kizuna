import { useEffect, useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Check, Database, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface SchemaFilterDialogProps {
  open: boolean
  saving?: boolean
  schemas: string[]
  selectedSchemas: string[] | null
  onOpenChange: (open: boolean) => void
  onSave: (schemas: string[] | null) => Promise<void> | void
}

function equalSchemaLists(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export function SchemaFilterDialog({
  open,
  saving = false,
  schemas,
  selectedSchemas,
  onOpenChange,
  onSave,
}: SchemaFilterDialogProps) {
  const defaultSelection = useMemo(() => selectedSchemas ?? schemas, [schemas, selectedSchemas])
  const [draftSelection, setDraftSelection] = useState<string[]>(defaultSelection)

  useEffect(() => {
    if (open) {
      setDraftSelection(defaultSelection)
    }
  }, [defaultSelection, open])

  const selectedCount = draftSelection.length
  const canSelectAll = selectedCount < schemas.length
  const canDeselectAll = selectedCount > 0
  const isUnchanged = equalSchemaLists(draftSelection, defaultSelection)

  const toggleSchema = (schema: string) => {
    setDraftSelection((current) =>
      current.includes(schema)
        ? current.filter((entry) => entry !== schema)
        : [...current, schema].sort((left, right) => left.localeCompare(right))
    )
  }

  const handleSave = async () => {
    await onSave(draftSelection.length === schemas.length ? null : draftSelection)
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/55 backdrop-blur-[1px]" />
        <Dialog.Content
          aria-describedby="schema-filter-description"
          className="fixed left-1/2 top-1/2 z-50 flex w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-sm border border-border bg-background shadow-2xl"
        >
          <div className="flex items-start justify-between border-b border-border px-5 py-4">
            <div className="space-y-1">
              <Dialog.Title className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Database className="h-4 w-4 text-[hsl(var(--accent))]" />
                Visible Schemas
              </Dialog.Title>
              <Dialog.Description
                id="schema-filter-description"
                className="max-w-md text-xs leading-5 text-muted-foreground"
              >
                Show only the schemas you care about in the object tree. System and temp schemas stay hidden automatically.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded-sm p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label="Close schema filter dialog"
              >
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </div>

          <div className="space-y-4 px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="rounded-sm border border-border bg-muted/20 px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                {selectedCount} of {schemas.length} visible
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={!canSelectAll || saving}
                  className="h-7 px-2.5 text-[11px] font-mono"
                  onClick={() => setDraftSelection(schemas)}
                >
                  Select all
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={!canDeselectAll || saving}
                  className="h-7 px-2.5 text-[11px] font-mono"
                  onClick={() => setDraftSelection([])}
                >
                  Deselect all
                </Button>
              </div>
            </div>

            <div className="max-h-[21rem] overflow-y-auto rounded-sm border border-border bg-muted/10 p-1">
              {schemas.length === 0 ? (
                <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                  No user schemas were returned for this connection.
                </div>
              ) : (
                <div className="space-y-1">
                  {schemas.map((schema) => {
                    const checked = draftSelection.includes(schema)
                    return (
                      <label
                        key={schema}
                        className={cn(
                          'flex cursor-pointer items-center gap-3 rounded-sm border px-3 py-2 transition-colors',
                          checked
                            ? 'border-[hsl(var(--accent))]/25 bg-[hsl(var(--accent))]/8'
                            : 'border-transparent hover:border-border hover:bg-background'
                        )}
                      >
                        <span
                          className={cn(
                            'flex h-4 w-4 items-center justify-center rounded-sm border text-background transition-colors',
                            checked
                              ? 'border-[hsl(var(--accent))] bg-[hsl(var(--accent))]'
                              : 'border-border bg-background text-transparent'
                          )}
                        >
                          <Check className="h-3 w-3" />
                        </span>
                        <input
                          type="checkbox"
                          className="sr-only"
                          checked={checked}
                          onChange={() => toggleSchema(schema)}
                        />
                        <span className="min-w-0 flex-1 truncate font-mono text-sm text-foreground">{schema}</span>
                      </label>
                    )
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between border-t border-border bg-muted/10 px-5 py-3">
            <p className="text-xs text-muted-foreground">
              Clearing the filter shows every non-system schema again.
            </p>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={saving}
                className="h-8 px-3 font-mono text-[11px]"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={saving || schemas.length === 0 || isUnchanged}
                className="h-8 px-3 font-mono text-[11px]"
                onClick={() => void handleSave()}
              >
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
