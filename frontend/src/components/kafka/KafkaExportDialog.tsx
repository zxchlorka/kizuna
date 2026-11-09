import { useState } from 'react'
import { Download, ListTree, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { JsonFieldPickerDialog } from '@/components/kafka/JsonFieldPickerDialog'
import type { KafkaDirection, KafkaMessageRow, KafkaSeek } from '@/stores/kafka'

interface KafkaExportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  // Fields the dialog opens with: the JSON columns already added to the table.
  initialFields: string[]
  // Loaded messages, for the field picker.
  messages: KafkaMessageRow[]
  // What the toolbar has applied; shown so the user sees what the file covers.
  partitionFilter: number | null
  seek: KafkaSeek
  direction: KafkaDirection
  conditionCount: number
  // Registers the export with the progress panel and returns its download URL.
  startDownload: (fields: string[]) => string
}

// describeRange says which part of each partition goes into the file, in the
// toolbar's own terms: with newest first the seek is where reading starts going
// back, so the file holds that point and everything older.
export function describeRange(seek: KafkaSeek, direction: KafkaDirection): string {
  const towards = direction === 'oldest' ? 'From' : 'Up to'
  if (seek.offset.trim() !== '') {
    return `${towards} offset ${seek.offset.trim()}`
  }
  if (seek.timestamp.trim() !== '') {
    const at = new Date(seek.timestamp)
    const shown = Number.isNaN(at.getTime()) ? seek.timestamp : at.toLocaleString()
    return `${towards} ${shown}`
  }
  return 'Whole topic'
}

export function KafkaExportDialog({
  open,
  onOpenChange,
  initialFields,
  messages,
  partitionFilter,
  seek,
  direction,
  conditionCount,
  startDownload,
}: KafkaExportDialogProps) {
  // Seeded once per mount; the browser mounts this only while it is open, so
  // every open starts from the table's current columns and a re-render of the
  // parent never wipes what is being typed.
  const [fields, setFields] = useState<string[]>(() => (initialFields.length > 0 ? [...initialFields] : ['']))
  const [pickerIndex, setPickerIndex] = useState<number | null>(null)

  const chosen = fields.map((field) => field.trim()).filter((field) => field !== '')

  const update = (index: number, value: string) =>
    setFields((current) => current.map((field, at) => (at === index ? value : field)))

  const remove = (index: number) =>
    setFields((current) => (current.length > 1 ? current.filter((_, at) => at !== index) : ['']))

  const download = () => {
    if (chosen.length === 0) return
    // A plain link: the browser streams the file to disk however large it is,
    // and a broken transfer is reported as a failed download. How far the
    // export has read shows in the panel bottom-left.
    const link = document.createElement('a')
    link.href = startDownload(chosen)
    link.download = ''
    document.body.appendChild(link)
    link.click()
    link.remove()
    onOpenChange(false)
  }

  const scope: Array<[string, string]> = [
    ['Partition', partitionFilter === null ? 'All' : String(partitionFilter)],
    ['Range', `${describeRange(seek, direction)}, as of now`],
    ['Filters', conditionCount === 0 ? 'None' : `${conditionCount} condition${conditionCount === 1 ? '' : 's'}`],
  ]

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg [&>*]:min-w-0">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">Export fields to CSV</DialogTitle>
            <DialogDescription className="font-mono text-xs">
              One column per field. Messages with none of them are skipped.
            </DialogDescription>
          </DialogHeader>

          <form
            id="kafka-export-form"
            className="flex max-h-[40vh] flex-col gap-2 overflow-y-auto"
            onSubmit={(event) => {
              event.preventDefault()
              download()
            }}
          >
            {fields.map((field, index) => (
              <div key={index} className="flex items-center gap-2">
                <input
                  value={field}
                  onChange={(event) => update(index, event.target.value)}
                  placeholder="JSON path, e.g. user_id or items[].id"
                  title="A path through [] collects every element into one cell"
                  aria-label={`Field ${index + 1}`}
                  spellCheck={false}
                  autoComplete="off"
                  autoFocus={index === 0}
                  className="h-8 min-w-0 flex-1 rounded-sm border border-border bg-background px-2 font-mono text-xs outline-none placeholder:text-muted-foreground focus:border-orange-500/50"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8 w-8 shrink-0 p-0"
                  onClick={() => setPickerIndex(index)}
                  disabled={messages.length === 0}
                  title="Pick a field from the loaded messages"
                  aria-label={`Choose field ${index + 1}`}
                >
                  <ListTree className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-8 w-8 shrink-0 p-0 text-muted-foreground"
                  onClick={() => remove(index)}
                  aria-label={`Remove field ${index + 1}`}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 w-fit gap-1.5 px-2 font-mono text-[11px] text-muted-foreground"
              onClick={() => setFields((current) => [...current, ''])}
            >
              <Plus className="h-3.5 w-3.5" />
              Add field
            </Button>
          </form>

          {/* What the file covers, taken from the toolbar. Changing it means
              closing this and changing the toolbar, so it is read-only here. */}
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-sm border border-border bg-muted/30 px-3 py-2 font-mono text-xs">
            {scope.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="text-foreground">{value}</dd>
              </div>
            ))}
          </dl>

          <DialogFooter>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="font-mono text-xs"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              form="kafka-export-form"
              size="sm"
              className="gap-1.5 font-mono text-xs"
              disabled={chosen.length === 0}
            >
              <Download className="h-3.5 w-3.5" />
              Download CSV
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <JsonFieldPickerDialog
        open={pickerIndex !== null}
        onOpenChange={(next) => {
          if (!next) setPickerIndex(null)
        }}
        messages={messages}
        onUseField={(path) => {
          if (pickerIndex !== null) update(pickerIndex, path)
        }}
      />
    </>
  )
}
