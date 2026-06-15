import { useMemo, useState } from 'react'
import { Loader2, Plus, Send, Trash2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { expandMessages, type ExpandInputs, type ProduceMode } from '@/lib/kafkaTemplate'
import { useKafkaStore } from '@/stores/kafka'
import { useToastStore } from '@/stores/toast'

interface KafkaProduceModalProps {
  open: boolean
  connId: string
  topic: string
  partitionCount: number
  onOpenChange: (open: boolean) => void
  onProduced?: () => void
}

const autoPartition = '__auto__'

const modes: Array<{ id: ProduceMode; label: string }> = [
  { id: 'single', label: 'Single' },
  { id: 'multi', label: 'Multi' },
  { id: 'loop', label: 'Loop' },
]

const valuePlaceholders: Record<ProduceMode, string> = {
  single: '{ "profile_id": 100, "status": "pending" }',
  multi: '{ "id": 1 },\n{ "id": 2 },\n{ "id": 3 }',
  loop: '{\n  "profile_id": {{i}},\n  "created_at": {{1234+i}},\n  "bucket": {{i%2}}\n}',
}

const PREVIEW_LIMIT = 5

export function KafkaProduceModal({
  open,
  connId,
  topic,
  partitionCount,
  onOpenChange,
  onProduced,
}: KafkaProduceModalProps) {
  const produce = useKafkaStore((state) => state.produce)
  const pushToast = useToastStore((state) => state.push)

  const [mode, setMode] = useState<ProduceMode>('single')
  const [topicName, setTopicName] = useState(topic)
  const [partition, setPartition] = useState<string>(autoPartition)
  const [keyTemplate, setKeyTemplate] = useState('')
  const [value, setValue] = useState('')
  const [headers, setHeaders] = useState<Array<{ key: string; value: string }>>([])
  const [start, setStart] = useState('100')
  const [step, setStep] = useState('100')
  const [count, setCount] = useState('5')
  const [sending, setSending] = useState(false)

  const loopParams = useMemo(
    () => ({
      start: Number.parseFloat(start),
      step: Number.parseFloat(step),
      count: Number.parseInt(count, 10),
    }),
    [start, step, count]
  )

  const expansion = useMemo(() => {
    if (value.trim() === '') {
      return { messages: [], errors: [] }
    }
    const inputs: ExpandInputs = { mode, value, key: keyTemplate, headers, loop: loopParams }
    return expandMessages(inputs)
  }, [mode, value, keyTemplate, headers, loopParams])

  const canSend = !sending && expansion.messages.length > 0 && expansion.errors.length === 0

  const updateHeader = (index: number, patch: Partial<{ key: string; value: string }>) => {
    setHeaders((prev) => prev.map((header, i) => (i === index ? { ...header, ...patch } : header)))
  }

  const handleSend = async () => {
    if (!canSend) {
      return
    }
    setSending(true)
    try {
      const result = await produce(connId, {
        topic: topicName.trim(),
        partition: partition === autoPartition ? null : Number.parseInt(partition, 10),
        messages: expansion.messages.map((message) => ({
          key: message.key || undefined,
          value: message.value,
          headers: Object.keys(message.headers).length > 0 ? message.headers : undefined,
        })),
      })
      pushToast({
        tone: result.failed > 0 ? 'error' : 'success',
        title: result.failed > 0 ? 'Produced with errors' : 'Messages produced',
        message: `Produced ${result.produced}${result.failed > 0 ? `, failed ${result.failed}` : ''} to ${topicName.trim()}`,
      })
      if (result.produced > 0) {
        onProduced?.()
      }
      if (result.failed === 0) {
        onOpenChange(false)
      }
    } catch (error) {
      pushToast({ tone: 'error', title: 'Produce failed', message: (error as Error).message })
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">Produce to Kafka</DialogTitle>
          <DialogDescription className="text-xs">
            Single message, several comma-separated JSON objects, or a loop with{' '}
            <code className="rounded-sm bg-muted px-1 font-mono">{'{{ i }}'}</code> expressions.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center gap-1 rounded-sm border border-border bg-muted/10 p-1">
            {modes.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setMode(item.id)}
                className={cn(
                  'flex-1 rounded-sm px-3 py-1.5 font-mono text-xs transition-colors',
                  mode === item.id ? 'bg-orange-500/15 text-orange-600 dark:text-orange-400' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">Topic</label>
              <Input value={topicName} onChange={(event) => setTopicName(event.target.value)} className="font-mono text-xs" />
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">Partition</label>
              <Select value={partition} onValueChange={setPartition}>
                <SelectTrigger className="h-9 font-mono text-xs">
                  <SelectValue placeholder="Auto" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={autoPartition}>Auto (by key)</SelectItem>
                  {Array.from({ length: partitionCount }, (_, index) => (
                    <SelectItem key={index} value={String(index)} className="font-mono text-xs">
                      Partition {index}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              Key <span className="text-muted-foreground/60">(optional{mode === 'loop' ? ', supports {{i}}' : ''})</span>
            </label>
            <Input
              value={keyTemplate}
              onChange={(event) => setKeyTemplate(event.target.value)}
              placeholder={mode === 'loop' ? 'order-{{i}}' : 'order-100'}
              className="font-mono text-xs"
            />
          </div>

          {mode === 'loop' && (
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="mb-1 block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">Start</label>
                <Input value={start} onChange={(event) => setStart(event.target.value)} inputMode="numeric" className="font-mono text-xs" />
              </div>
              <div>
                <label className="mb-1 block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">Step</label>
                <Input value={step} onChange={(event) => setStep(event.target.value)} inputMode="numeric" className="font-mono text-xs" />
              </div>
              <div>
                <label className="mb-1 block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">Count</label>
                <Input value={count} onChange={(event) => setCount(event.target.value)} inputMode="numeric" className="font-mono text-xs" />
              </div>
            </div>
          )}

          <div>
            <label className="mb-1 block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              {mode === 'multi' ? 'Messages (comma-separated JSON)' : mode === 'loop' ? 'Template' : 'Value (JSON)'}
            </label>
            <Textarea
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={valuePlaceholders[mode]}
              className="min-h-32 font-mono text-xs"
            />
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">Headers (optional)</label>
              <Button type="button" size="sm" variant="ghost" className="h-6 gap-1 px-2 font-mono text-[10px]" onClick={() => setHeaders((prev) => [...prev, { key: '', value: '' }])}>
                <Plus className="h-3 w-3" />
                Add
              </Button>
            </div>
            {headers.map((header, index) => (
              <div key={index} className="mb-1.5 flex items-center gap-2">
                <Input value={header.key} onChange={(event) => updateHeader(index, { key: event.target.value })} placeholder="header" className="h-8 font-mono text-xs" />
                <Input value={header.value} onChange={(event) => updateHeader(index, { value: event.target.value })} placeholder={mode === 'loop' ? 'value or {{i}}' : 'value'} className="h-8 font-mono text-xs" />
                <Button type="button" size="icon" variant="ghost" className="h-8 w-8 shrink-0 text-muted-foreground" onClick={() => setHeaders((prev) => prev.filter((_, i) => i !== index))}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>

          <div className="rounded-sm border border-border bg-muted/10 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Preview</span>
              <span className="font-mono text-[11px] text-muted-foreground">
                {expansion.errors.length > 0 ? 'invalid' : `${expansion.messages.length} message${expansion.messages.length === 1 ? '' : 's'}`}
              </span>
            </div>
            {expansion.errors.length > 0 ? (
              <div className="space-y-1">
                {expansion.errors.slice(0, 5).map((error, index) => (
                  <div key={index} className="font-mono text-[11px] text-red-500">{error}</div>
                ))}
              </div>
            ) : expansion.messages.length === 0 ? (
              <div className="font-mono text-[11px] text-muted-foreground">Enter a value to see the expanded messages.</div>
            ) : (
              <div className="space-y-1.5">
                {expansion.messages.slice(0, PREVIEW_LIMIT).map((message, index) => (
                  <div key={index} className="overflow-x-auto whitespace-pre rounded-sm border border-border/60 bg-background/60 px-2 py-1 font-mono text-[11px]">
                    {message.key ? <span className="text-cyan-700 dark:text-cyan-300">{message.key} → </span> : null}
                    {message.value}
                  </div>
                ))}
                {expansion.messages.length > PREVIEW_LIMIT && (
                  <div className="font-mono text-[11px] text-muted-foreground">… and {expansion.messages.length - PREVIEW_LIMIT} more</div>
                )}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" size="sm" className="gap-1.5 bg-orange-500 text-white hover:bg-orange-400" disabled={!canSend} onClick={() => void handleSend()}>
            {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            Produce {expansion.messages.length > 0 && expansion.errors.length === 0 ? expansion.messages.length : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
