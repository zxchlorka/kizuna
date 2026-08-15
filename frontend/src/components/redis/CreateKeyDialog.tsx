import { useEffect, useMemo, useState } from 'react'
import { Database, Hash, List, ListOrdered, Plus, SquareCode, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import type { RedisObjectType } from '@/types/api'
import { formatRedisTTL, getRedisObjectTypeLabel, toNumberOrNull } from '@/components/redis/redisUtils'

type CreateableRedisObjectType = Exclude<RedisObjectType, 'redis_stream' | 'redis_json'>

export interface CreateEntry {
  field: string
  value: string
  score: string
}

interface CreateKeyDialogProps {
  open: boolean
  saving: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (payload: {
    key: string
    type: CreateableRedisObjectType
    ttl?: number | null
    value: string
    entries: CreateEntry[]
    direction?: 'left' | 'right'
  }) => Promise<void> | void
}

const TYPE_OPTIONS: Array<{ value: CreateableRedisObjectType; icon: typeof Database }> = [
  { value: 'redis_string', icon: Database },
  { value: 'redis_hash', icon: Hash },
  { value: 'redis_list', icon: List },
  { value: 'redis_set', icon: SquareCode },
  { value: 'redis_zset', icon: ListOrdered },
]

export function CreateKeyDialog({ open, saving, onOpenChange, onConfirm }: CreateKeyDialogProps) {
  const [keyName, setKeyName] = useState('')
  const [type, setType] = useState<CreateableRedisObjectType>('redis_string')
  const [ttlText, setTtlText] = useState('')
  const [value, setValue] = useState('')
  // One row shape for every collection type: hash uses field+value, zset
  // value+score, list and set only value. A single list beats three parallel
  // ones that would have to be kept in step as the type changes.
  const [entries, setEntries] = useState<CreateEntry[]>([{ field: '', value: '', score: '0' }])
  const [direction, setDirection] = useState<'left' | 'right'>('right')
  const [error, setError] = useState<string | null>(null)

  const updateEntry = (index: number, patch: Partial<CreateEntry>) => {
    setEntries((current) => current.map((entry, at) => (at === index ? { ...entry, ...patch } : entry)))
    setError(null)
  }

  useEffect(() => {
    if (!open) {
      return
    }
    setError(null)
    setKeyName('')
    setType('redis_string')
    setTtlText('')
    setValue('')
    setEntries([{ field: '', value: '', score: '0' }])
    setDirection('right')
  }, [open])

  const ttlPreview = useMemo(() => {
    const parsed = toNumberOrNull(ttlText)
    if (parsed === null) {
      return ttlText.trim() === '' ? 'No TTL' : 'Invalid'
    }
    if (parsed === -1) return 'No TTL'
    return formatRedisTTL(parsed) ?? 'No TTL'
  }, [ttlText])

  const typeLabel = getRedisObjectTypeLabel(type)

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    const trimmedKey = keyName.trim()
    if (!trimmedKey) {
      setError('Key name is required.')
      return
    }

    const ttl = ttlText.trim() === '' ? null : toNumberOrNull(ttlText)
    if (ttlText.trim() !== '' && ttl === null) {
      setError('TTL must be a valid number of seconds.')
      return
    }
    if (ttl !== null && ttl < -1) {
      setError('TTL cannot be lower than -1.')
      return
    }

    const isCollection = type !== 'redis_string'
    const filled = entries.filter((entry) => entry.value.trim() !== '' || entry.field.trim() !== '')

    if (!isCollection && value.trim() === '') {
      setError('A value is required for a string key.')
      return
    }
    if (isCollection && filled.length === 0) {
      setError('Add at least one entry for this key type.')
      return
    }
    if (type === 'redis_hash' && filled.some((entry) => entry.field.trim() === '')) {
      setError('Every hash entry needs a field name.')
      return
    }
    if (isCollection && filled.some((entry) => entry.value.trim() === '')) {
      setError('Every entry needs a value.')
      return
    }
    if (type === 'redis_zset' && filled.some((entry) => toNumberOrNull(entry.score) === null)) {
      setError('Every score must be a valid number.')
      return
    }

    setError(null)
    await onConfirm({
      key: trimmedKey,
      type,
      ttl,
      value,
      entries: filled,
      direction,
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <form onSubmit={handleSubmit} className="space-y-5">
          <DialogHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-md border border-red-500/20 bg-red-500/10 text-red-500">
                <Plus className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <DialogTitle className="font-mono text-sm">Create Key</DialogTitle>
                <DialogDescription className="font-mono text-[11px] text-muted-foreground">
                  New Redis key with initial value
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2 md:col-span-2">
              <label className="block text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Key name</label>
              <Input
                value={keyName}
                onChange={(event) => {
                  setKeyName(event.target.value)
                  setError(null)
                }}
                placeholder="cache:user:42"
                className="font-mono"
              />
            </div>

            <div className="space-y-2">
              <label className="block text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Type</label>
              <Select
                value={type}
                onValueChange={(next) => {
                  setType(next as CreateableRedisObjectType)
                  setError(null)
                }}
              >
                <SelectTrigger className="h-10 text-xs font-mono">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TYPE_OPTIONS.map((option) => {
                    const Icon = option.icon
                    return (
                      <SelectItem key={option.value} value={option.value}>
                        <span className="flex items-center gap-2">
                          <Icon className="h-3.5 w-3.5" />
                          {getRedisObjectTypeLabel(option.value)}
                        </span>
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="block text-[10px] uppercase tracking-[0.14em] text-muted-foreground">TTL</label>
              <Input
                value={ttlText}
                onChange={(event) => {
                  setTtlText(event.target.value)
                  setError(null)
                }}
                inputMode="numeric"
                placeholder="optional"
                className="font-mono"
              />
            </div>

            <div className="rounded-sm border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground md:col-span-2">
              Selected type: <span className="font-mono text-foreground">{typeLabel}</span> • TTL preview:{' '}
              <span className="font-mono text-foreground">{ttlPreview}</span>
            </div>

            {type !== 'redis_string' && (
              <div className="space-y-2 md:col-span-2">
                <div className="flex items-center justify-between">
                  <label className="block text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                    {type === 'redis_hash' ? 'Fields' : type === 'redis_zset' ? 'Members' : 'Values'}
                  </label>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1.5 font-mono text-[11px]"
                    onClick={() => setEntries((current) => [...current, { field: '', value: '', score: '0' }])}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add
                  </Button>
                </div>

                {/* A collection is rarely created with exactly one entry, and
                    filling in the rest afterwards one at a time was the tedious
                    part. These rows map onto what the backend already accepts:
                    a map for a hash, a list of members for the rest. */}
                <div className="max-h-64 space-y-2 overflow-y-auto">
                  {entries.map((entry, index) => (
                    <div key={index} className="flex items-center gap-2">
                      {type === 'redis_hash' && (
                        <Input
                          value={entry.field}
                          onChange={(event) => updateEntry(index, { field: event.target.value })}
                          placeholder="field"
                          className="w-1/3 font-mono"
                          aria-label={`Field for entry ${index + 1}`}
                        />
                      )}
                      {type === 'redis_zset' && (
                        <Input
                          value={entry.score}
                          onChange={(event) => updateEntry(index, { score: event.target.value })}
                          placeholder="score"
                          className="w-24 font-mono"
                          aria-label={`Score for entry ${index + 1}`}
                        />
                      )}
                      <Input
                        value={entry.value}
                        onChange={(event) => updateEntry(index, { value: event.target.value })}
                        placeholder={type === 'redis_hash' ? 'value' : type === 'redis_set' ? 'member' : 'item'}
                        className="flex-1 font-mono"
                        aria-label={`Value for entry ${index + 1}`}
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className={cn('h-9 w-9 shrink-0 p-0', entries.length === 1 && 'invisible')}
                        onClick={() => setEntries((current) => current.filter((_, at) => at !== index))}
                        aria-label={`Remove entry ${index + 1}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>

                {type === 'redis_list' && (
                  <div className="flex items-center gap-2 pt-1">
                    <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Direction</span>
                    <Button
                      type="button"
                      variant={direction === 'left' ? 'secondary' : 'outline'}
                      size="sm"
                      className="h-8 font-mono text-xs"
                      onClick={() => setDirection('left')}
                    >
                      LPUSH
                    </Button>
                    <Button
                      type="button"
                      variant={direction === 'right' ? 'secondary' : 'outline'}
                      size="sm"
                      className="h-8 font-mono text-xs"
                      onClick={() => setDirection('right')}
                    >
                      RPUSH
                    </Button>
                  </div>
                )}
              </div>
            )}

            {type === 'redis_string' && (
              <div className="space-y-2 md:col-span-2">
                <label className="block text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Value</label>
                <Textarea
                  value={value}
                  onChange={(event) => {
                    setValue(event.target.value)
                    setError(null)
                  }}
                  placeholder="string value or JSON text"
                  className="min-h-28 font-mono"
                />
              </div>
            )}
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" size="sm" className="h-8 px-3">
                <X className="h-3.5 w-3.5" />
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" size="sm" className={cn('h-8 px-3')} disabled={saving}>
              {saving ? 'Creating…' : 'Create Key'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
