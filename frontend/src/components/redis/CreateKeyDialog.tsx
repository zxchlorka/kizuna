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

interface CreateKeyDialogProps {
  open: boolean
  saving: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (payload: {
    key: string
    type: CreateableRedisObjectType
    ttl?: number | null
    value: string
    field?: string
    score?: number
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
  const [field, setField] = useState('')
  const [scoreText, setScoreText] = useState('0')
  const [direction, setDirection] = useState<'left' | 'right'>('right')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      return
    }
    setError(null)
    setKeyName('')
    setType('redis_string')
    setTtlText('')
    setValue('')
    setField('')
    setScoreText('0')
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

    const score = type === 'redis_zset' ? toNumberOrNull(scoreText) : null
    if (type === 'redis_zset' && score === null) {
      setError('Score must be a valid number.')
      return
    }

    if ((type === 'redis_hash' || type === 'redis_list' || type === 'redis_set' || type === 'redis_zset') && value.trim() === '') {
      setError('Initial value is required for this key type.')
      return
    }
    if (type === 'redis_hash' && field.trim() === '') {
      setError('Field name is required for hash keys.')
      return
    }

    setError(null)
    await onConfirm({
      key: trimmedKey,
      type,
      ttl,
      value,
      field: field.trim() || undefined,
      score: score ?? undefined,
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

            {type === 'redis_hash' && (
              <>
                <div className="space-y-2">
                  <label className="block text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Field</label>
                  <Input
                    value={field}
                    onChange={(event) => {
                      setField(event.target.value)
                      setError(null)
                    }}
                    placeholder="name"
                    className="font-mono"
                  />
                </div>
                <div className="space-y-2">
                  <label className="block text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Value</label>
                  <Input
                    value={value}
                    onChange={(event) => {
                      setValue(event.target.value)
                      setError(null)
                    }}
                    placeholder="John"
                    className="font-mono"
                  />
                </div>
              </>
            )}

            {type === 'redis_list' && (
              <>
                <div className="space-y-2 md:col-span-2">
                  <label className="block text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Value</label>
                  <Textarea
                    value={value}
                    onChange={(event) => {
                      setValue(event.target.value)
                      setError(null)
                    }}
                    placeholder="First item"
                    className="min-h-24 font-mono"
                  />
                </div>
                <div className="space-y-2">
                  <label className="block text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Direction</label>
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      type="button"
                      variant={direction === 'left' ? 'secondary' : 'outline'}
                      size="sm"
                      className="h-9 font-mono text-xs"
                      onClick={() => setDirection('left')}
                    >
                      LPUSH
                    </Button>
                    <Button
                      type="button"
                      variant={direction === 'right' ? 'secondary' : 'outline'}
                      size="sm"
                      className="h-9 font-mono text-xs"
                      onClick={() => setDirection('right')}
                    >
                      RPUSH
                    </Button>
                  </div>
                </div>
              </>
            )}

            {type === 'redis_set' && (
              <div className="space-y-2 md:col-span-2">
                <label className="block text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Member</label>
                <Input
                  value={value}
                  onChange={(event) => {
                    setValue(event.target.value)
                    setError(null)
                  }}
                  placeholder="member-1"
                  className="font-mono"
                />
              </div>
            )}

            {type === 'redis_zset' && (
              <>
                <div className="space-y-2">
                  <label className="block text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Score</label>
                  <Input
                    value={scoreText}
                    onChange={(event) => {
                      setScoreText(event.target.value)
                      setError(null)
                    }}
                    placeholder="1.0"
                    className="font-mono"
                  />
                </div>
                <div className="space-y-2">
                  <label className="block text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Member</label>
                  <Input
                    value={value}
                    onChange={(event) => {
                      setValue(event.target.value)
                      setError(null)
                    }}
                    placeholder="member-1"
                    className="font-mono"
                  />
                </div>
              </>
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
