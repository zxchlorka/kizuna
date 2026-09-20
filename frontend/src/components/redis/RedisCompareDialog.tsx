import { useCallback, useEffect, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { KeyPicker } from '@/components/redis/KeyPicker'
import { fetchWithTimeout, throwOnApiError } from '@/lib/http'
import { compareDocuments, type CompareDocument } from '@/lib/redisCompare'
import { cn } from '@/lib/utils'

/**
 * Five keys is the ceiling.
 *
 * Not a technical limit — five columns is where the table still reads on one
 * screen, and past that the question stops being "what do these share" and
 * becomes a report nobody looks at in a dialog.
 */
export const MAX_COMPARED = 5

interface RedisCompareDialogProps {
  open: boolean
  connId: string
  /** The key the comparison was opened from; always the first column. */
  anchor: string
  anchorType: string
  onOpenChange: (open: boolean) => void
}

export function RedisCompareDialog({ open, connId, anchor, anchorType, onOpenChange }: RedisCompareDialogProps) {
  const [keys, setKeys] = useState<string[]>([])
  const [docs, setDocs] = useState<CompareDocument[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hideEmpty, setHideEmpty] = useState(true)

  useEffect(() => {
    if (open) {
      setKeys([])
      setDocs([])
      setError(null)
    }
  }, [open, anchor])

  const load = useCallback(async () => {
    const all = [anchor, ...keys]
    setLoading(true)
    setError(null)
    try {
      // Read whole, on the server. The key viewer pages large collections, so a
      // comparison built from what is on screen would call values shared
      // because they happened to land on the same page.
      const loaded = await Promise.all(
        all.map(async (key) => {
          const res = await fetchWithTimeout(
            `/api/connections/${connId}/objects/${encodeURIComponent(key)}/export`
          )
          await throwOnApiError(res)
          return (await res.json()) as CompareDocument
        })
      )

      // Comparing a hash to a sorted set has no answer worth showing: their
      // rows mean different things, and lining them up would invent agreement.
      const mismatched = loaded.find((doc) => doc.type !== loaded[0].type)
      if (mismatched) {
        throw new Error(`${mismatched.key} is a ${mismatched.type}, not a ${loaded[0].type}`)
      }
      setDocs(loaded)
    } catch (loadError) {
      setError((loadError as Error).message)
      setDocs([])
    } finally {
      setLoading(false)
    }
  }, [anchor, keys, connId])



  const result = docs.length > 1 ? compareDocuments(docs) : null
  const rows = result?.rows.filter((row) => !hideEmpty || !row.allEmpty) ?? []
  const hiddenCount = (result?.rows.length ?? 0) - rows.length

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogContent className="max-w-5xl [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">Compare keys</DialogTitle>
          <DialogDescription className="font-mono text-xs">
            Shows which values these keys have in common. A field holding a comma-separated list is compared
            element by element, so two keys sharing one id are found even when the rest differs.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-sm border border-border bg-muted/40 px-2 py-1 font-mono text-[11px]">
            {anchor}
            <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{anchorType}</span>
          </span>
          {keys.map((key) => (
            <span
              key={key}
              className="inline-flex items-center gap-1.5 rounded-sm border border-border px-2 py-1 font-mono text-[11px]"
            >
              {key}
              <button
                type="button"
                onClick={() => setKeys((current) => current.filter((item) => item !== key))}
                aria-label={`Remove ${key}`}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>

        {keys.length + 1 < MAX_COMPARED && (
          <KeyPicker
            connId={connId}
            taken={[anchor, ...keys]}
            onPick={(picked) => setKeys((current) => [...current, ...picked].slice(0, MAX_COMPARED - 1))}
          />
        )}

        <div className="flex items-center justify-between gap-2">
          <Button
            type="button"
            size="sm"
            className="h-8 font-mono text-[11px]"
            disabled={keys.length === 0 || loading}
            onClick={() => void load()}
          >
            {loading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            Compare {keys.length + 1}
          </Button>
          {result && (
            <button
              type="button"
              onClick={() => setHideEmpty((current) => !current)}
              className="font-mono text-[11px] text-muted-foreground hover:text-foreground"
            >
              {hideEmpty ? `show ${hiddenCount} empty` : 'hide empty'}
            </button>
          )}
        </div>

        {error && (
          <div className="rounded-sm border border-destructive/40 bg-destructive/5 px-3 py-2 font-mono text-[11px] text-destructive">
            {error}
          </div>
        )}

        {result && (
          <>
            {/* The answer, before the table anyone has to read. On profiles this
                is the line that says why two of them should have been one. */}
            {result.sharedValues.length > 0 ? (
              <div className="rounded-sm border border-emerald-500/35 bg-emerald-500/[0.08] px-3 py-2 font-mono text-[11px]">
                <span className="text-[10px] uppercase tracking-[0.14em] text-emerald-600 dark:text-emerald-500">
                  In common
                </span>
                <div className="mt-1 flex flex-col gap-0.5">
                  {result.sharedValues.slice(0, 6).map((hit) => (
                    <div key={`${hit.field}:${hit.value}`} className="truncate">
                      <span className="text-muted-foreground">{hit.field}</span> {hit.value}{' '}
                      <span className="text-muted-foreground">· {hit.keys.length} keys</span>
                    </div>
                  ))}
                  {result.sharedValues.length > 6 && (
                    <div className="text-muted-foreground">…and {result.sharedValues.length - 6} more</div>
                  )}
                </div>
              </div>
            ) : (
              <div className="rounded-sm border border-border bg-muted/20 px-3 py-2 font-mono text-[11px] text-muted-foreground">
                No value occurs in more than one of these keys.
              </div>
            )}

            <div className="max-h-[50vh] overflow-auto rounded-sm border border-border">
              <table className="w-full font-mono text-[11px]">
                <thead className="sticky top-0 bg-card">
                  <tr className="border-b border-border text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                    <th className="px-2 py-2 text-left font-normal">Field</th>
                    {docs.map((doc) => (
                      <th key={doc.key} className="px-2 py-2 text-left font-normal" title={doc.key}>
                        <span className="block max-w-[14rem] truncate normal-case">{doc.key}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.field} className="border-b border-border/50 last:border-b-0">
                      <td className="px-2 py-1.5 align-top text-muted-foreground">{row.field}</td>
                      {row.cells.map((cell, index) => (
                        <td key={docs[index].key} className="px-2 py-1.5 align-top">
                          {cell.length === 0 ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <div className="flex flex-col gap-0.5">
                              {cell.map((value, at) => (
                                <span
                                  key={`${value.text}-${at}`}
                                  className={cn(
                                    'max-w-[14rem] truncate',
                                    value.shared && 'rounded-[2px] bg-emerald-500/15 px-1 text-emerald-700 dark:text-emerald-400'
                                  )}
                                  title={value.text}
                                >
                                  {value.text}
                                </span>
                              ))}
                            </div>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
