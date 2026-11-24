import { useRef, useState } from 'react'
import { FileUp, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { removeTopicProto, saveTopicProto, type TopicProto } from '@/stores/kafkaProto'

interface KafkaProtoDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  connId: string
  topic: string
  proto: TopicProto | null
  // Called after every change, with what is attached now.
  onChanged: (proto: TopicProto | null) => void
}

export function KafkaProtoDialog({ open, onOpenChange, connId, topic, proto, onChanged }: KafkaProtoDialogProps) {
  const fileInput = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (action: () => Promise<TopicProto | null>) => {
    setBusy(true)
    setError(null)
    try {
      onChanged(await action())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const attachFile = (file: File) =>
    void run(async () => saveTopicProto(connId, topic, { file_name: file.name, source: await file.text() }))

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null)
        onOpenChange(next)
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">Protobuf contract</DialogTitle>
          <DialogDescription className="font-mono text-xs">
            Binary messages of this topic are read as the chosen message type and shown as JSON. JSON and text
            messages stay as they are.
          </DialogDescription>
        </DialogHeader>

        {proto && (
          <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 rounded-sm border border-border bg-muted/30 px-3 py-2 font-mono text-xs">
            <dt className="text-muted-foreground">File</dt>
            <dd className="truncate text-foreground">{proto.file_name}</dd>
            <dt className="text-muted-foreground">Message</dt>
            <dd className="min-w-0">
              <Select
                value={proto.message}
                disabled={busy}
                onValueChange={(message) => void run(() => saveTopicProto(connId, topic, { message }))}
              >
                <SelectTrigger className="h-8 font-mono text-xs" aria-label="Message type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {proto.messages.map((message) => (
                    <SelectItem key={message} value={message} className="font-mono text-xs">
                      {message}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </dd>
          </dl>
        )}

        {error && (
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-2 font-mono text-xs text-destructive">
            {error}
          </pre>
        )}

        <input
          ref={fileInput}
          type="file"
          accept=".proto"
          className="hidden"
          aria-label="Choose a .proto file"
          onChange={(event) => {
            const file = event.target.files?.[0]
            // Cleared so picking the same file again, after fixing it, fires.
            event.target.value = ''
            if (file) attachFile(file)
          }}
        />

        <DialogFooter className="gap-2 sm:justify-between">
          {proto ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="gap-1.5 font-mono text-xs text-muted-foreground hover:text-destructive"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await removeTopicProto(connId, topic)
                  return null
                })
              }
            >
              <Trash2 className="h-3.5 w-3.5" />
              Remove
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant={proto ? 'outline' : 'default'}
              className="gap-1.5 font-mono text-xs"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              <FileUp className="h-3.5 w-3.5" />
              {proto ? 'Replace file' : 'Choose .proto file'}
            </Button>
            {proto && (
              <Button type="button" size="sm" className="font-mono text-xs" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
