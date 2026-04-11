import { useEffect, useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { ArrowRight, Link2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { FKRef, TableRow } from '@/types/api'

interface ReferencedByDialogProps {
  open: boolean
  connId: string
  row: TableRow | null
  references: FKRef[]
  onOpenChange: (open: boolean) => void
  onNavigate: (reference: FKRef, value: unknown) => void
}

interface ReferenceCountState {
  loading: boolean
  total: number | null
  error: string | null
}

function buildKey(reference: FKRef) {
  return `${reference.table}:${reference.column}:${reference.ref_column}`
}

export function ReferencedByDialog({
  open,
  connId,
  row,
  references,
  onOpenChange,
  onNavigate,
}: ReferencedByDialogProps) {
  const [counts, setCounts] = useState<Record<string, ReferenceCountState>>({})

  const visibleReferences = useMemo(
    () => references.filter((reference) => reference.ref_column in (row ?? {})),
    [references, row]
  )

  useEffect(() => {
    if (!open || !row || visibleReferences.length === 0) {
      return
    }

    let cancelled = false
    const initialState = Object.fromEntries(
      visibleReferences.map((reference) => [buildKey(reference), { loading: true, total: null, error: null }])
    )
    setCounts(initialState)

    void Promise.all(
      visibleReferences.map(async (reference) => {
        const value = row[reference.ref_column]
        const key = buildKey(reference)

        if (value === null || value === undefined) {
          return [key, { loading: false, total: 0, error: null }] satisfies [string, ReferenceCountState]
        }

        const params = new URLSearchParams({
          offset: '0',
          limit: '1',
          filters: JSON.stringify([{ column: reference.column, op: 'eq', value: String(value) }]),
        })

        try {
          const response = await fetch(
            `/api/connections/${connId}/objects/${encodeURIComponent(reference.table)}/data?${params.toString()}`
          )
          if (!response.ok) {
            const body = await response.json().catch(() => ({ error: response.statusText }))
            throw new Error(body.error || response.statusText)
          }

          const result: { total?: number } = await response.json()
          return [key, { loading: false, total: result.total ?? 0, error: null }] satisfies [string, ReferenceCountState]
        } catch (error) {
          return [key, { loading: false, total: null, error: (error as Error).message }] satisfies [
            string,
            ReferenceCountState,
          ]
        }
      })
    ).then((entries) => {
      if (cancelled) {
        return
      }
      setCounts(Object.fromEntries(entries))
    })

    return () => {
      cancelled = true
    }
  }, [connId, open, row, visibleReferences])

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/55 backdrop-blur-[1px]" />
        <Dialog.Content
          aria-describedby="referenced-by-description"
          className="fixed left-1/2 top-1/2 z-50 flex w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-sm border border-border bg-background shadow-2xl"
        >
          <div className="flex items-start justify-between border-b border-border px-5 py-4">
            <div className="space-y-1">
              <Dialog.Title className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Link2 className="h-4 w-4 text-[hsl(var(--accent))]" />
                Referenced By
              </Dialog.Title>
              <Dialog.Description
                id="referenced-by-description"
                className="max-w-md text-xs leading-5 text-muted-foreground"
              >
                Open rows from other tables that reference the selected record.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded-sm p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label="Close referenced by dialog"
              >
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </div>

          <div className="space-y-2 px-5 py-4">
            {visibleReferences.length === 0 ? (
              <div className="rounded border border-border bg-muted/10 px-3 py-4 text-sm text-muted-foreground">
                No reverse references are available for the selected row.
              </div>
            ) : (
              visibleReferences.map((reference) => {
                const key = buildKey(reference)
                const state = counts[key] ?? { loading: true, total: null, error: null }
                const value = row?.[reference.ref_column]
                const disabled = value === null || value === undefined

                return (
                  <button
                    key={key}
                    type="button"
                    disabled={disabled}
                    className={cn(
                      'flex w-full items-center justify-between rounded-sm border px-3 py-2 text-left transition-colors',
                      disabled
                        ? 'cursor-not-allowed border-border bg-muted/10 text-muted-foreground'
                        : 'border-border bg-background hover:border-[hsl(var(--accent))]/40 hover:bg-muted/15'
                    )}
                    onClick={() => {
                      if (disabled) {
                        return
                      }
                      onNavigate(reference, value)
                      onOpenChange(false)
                    }}
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-foreground">
                        {reference.table}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {reference.column} ← {reference.ref_column}
                      </div>
                    </div>

                    <div className="ml-4 flex items-center gap-3">
                      <span className="text-xs text-muted-foreground">
                        {state.loading
                          ? 'Loading...'
                          : state.error
                            ? 'Error'
                            : `${state.total ?? 0} records`}
                      </span>
                      <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                    </div>
                  </button>
                )
              })
            )}
          </div>

          <div className="flex justify-end border-t border-border bg-muted/10 px-5 py-3">
            <Button type="button" variant="outline" size="sm" className="h-8 px-3 text-[11px] font-mono" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
