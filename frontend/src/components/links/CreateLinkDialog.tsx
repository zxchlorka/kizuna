import { useEffect, useMemo, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useConnectionStore } from '@/stores/connections'
import { useLinksStore } from '@/stores/links'
import { useToastStore } from '@/stores/toast'
import type { LinkKind, LinkRecord, RedisExtract } from '@/types/api'

interface CreateLinkDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  // create mode (source pre-filled from the view); optional in edit mode
  sourceConnId?: string
  sourceKind?: LinkKind
  sourceScope?: string
  sourceFieldOptions?: string[]
  // edit mode: pre-fill from an existing link and PUT on save
  editLink?: LinkRecord
}

const labelClass = 'text-[10px] uppercase tracking-[0.14em] text-muted-foreground'
const inputClass =
  'h-8 w-full rounded-sm border border-border bg-background px-2 font-mono text-xs outline-none focus:border-orange-500/50'

export function CreateLinkDialog({
  open,
  onOpenChange,
  sourceConnId,
  sourceKind,
  sourceScope,
  sourceFieldOptions = [],
  editLink,
}: CreateLinkDialogProps) {
  const connections = useConnectionStore((state) => state.connections)
  const createLink = useLinksStore((state) => state.create)
  const updateLink = useLinksStore((state) => state.update)
  const pushToast = useToastStore((state) => state.push)

  const isEdit = !!editLink
  const srcKind = (editLink?.source_kind ?? sourceKind) as LinkKind
  const srcConnId = editLink?.source_conn_id ?? sourceConnId ?? ''
  const initialScope = editLink?.source_scope ?? sourceScope ?? ''

  const [sourceField, setSourceField] = useState('')
  const [redisExtract, setRedisExtract] = useState<RedisExtract>('value_field')
  const [scopeInput, setScopeInput] = useState(initialScope)
  const [targetConnId, setTargetConnId] = useState('')
  const [targetTopic, setTargetTopic] = useState('')
  const [targetSearchField, setTargetSearchField] = useState('')
  const [keyPattern, setKeyPattern] = useState('')
  const [table, setTable] = useState('')
  const [column, setColumn] = useState('')
  const [saving, setSaving] = useState(false)

  // (Re)initialize state whenever the dialog opens or the edited link changes.
  useEffect(() => {
    if (!open) return
    if (editLink) {
      setSourceField(editLink.source_field ?? '')
      setRedisExtract((editLink.source_extract as RedisExtract) ?? 'value_field')
      setScopeInput(editLink.source_scope ?? '')
      setTargetConnId(editLink.target_conn_id)
      setTargetTopic(editLink.target_topic ?? '')
      setTargetSearchField(editLink.target_field ?? '')
      setKeyPattern(editLink.key_pattern ?? '')
      setTable(editLink.table ?? '')
      setColumn(editLink.column ?? '')
    } else {
      setSourceField('')
      setRedisExtract('value_field')
      setScopeInput(sourceScope ?? '')
      setTargetConnId('')
      setTargetTopic('')
      setTargetSearchField('')
      setKeyPattern('')
      setTable('')
      setColumn('')
    }
    setSaving(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editLink])

  const targetConn = connections.find((conn) => conn.id === targetConnId)
  const targetKind: LinkKind | null =
    targetConn?.type === 'redis' ? 'redis' : targetConn?.type === 'postgres' ? 'postgres' : targetConn?.type === 'kafka' ? 'kafka' : null

  const targetOptions = useMemo(
    () => connections.filter((conn) => conn.type === 'redis' || conn.type === 'postgres' || conn.type === 'kafka'),
    [connections]
  )

  const needsSourceField =
    srcKind === 'kafka' || srcKind === 'postgres' || (srcKind === 'redis' && redisExtract === 'value_field')

  const effectiveScope = scopeInput.trim()

  const invalid =
    saving ||
    !targetKind ||
    !effectiveScope ||
    (needsSourceField && !sourceField) ||
    (srcKind === 'redis' && redisExtract === 'key_capture' && (effectiveScope.match(/\*/g)?.length ?? 0) !== 1) ||
    (targetKind === 'redis' && !keyPattern.includes('*')) ||
    (targetKind === 'postgres' && (!table || !column)) ||
    (targetKind === 'kafka' && (!targetTopic || !targetSearchField))

  const handleSave = async () => {
    if (invalid || !targetKind) {
      return
    }
    setSaving(true)
    const payload = {
      source_conn_id: srcConnId,
      source_kind: srcKind,
      source_scope: effectiveScope,
      source_field: needsSourceField ? sourceField : undefined,
      source_extract: srcKind === 'redis' ? redisExtract : undefined,
      target_conn_id: targetConnId,
      target_kind: targetKind,
      target_topic: targetKind === 'kafka' ? targetTopic : undefined,
      target_field: targetKind === 'kafka' ? targetSearchField : undefined,
      key_pattern: targetKind === 'redis' ? keyPattern : undefined,
      table: targetKind === 'postgres' ? table : undefined,
      column: targetKind === 'postgres' ? column : undefined,
    }
    try {
      if (editLink) {
        await updateLink(editLink.id, payload)
        pushToast({ tone: 'success', title: 'Link updated' })
      } else {
        await createLink(payload)
        pushToast({ tone: 'success', title: 'Link created' })
      }
      onOpenChange(false)
    } catch (error) {
      pushToast({ tone: 'error', title: isEdit ? 'Failed to update link' : 'Failed to create link', message: (error as Error).message })
    } finally {
      setSaving(false)
    }
  }

  const fieldControl = (value: string, onChange: (next: string) => void, placeholder: string) =>
    sourceFieldOptions.length > 0 ? (
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-8 font-mono text-xs">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {sourceFieldOptions.map((option) => (
            <SelectItem key={option} value={option} className="font-mono text-xs">
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    ) : (
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className={inputClass} />
    )

  const scopeLabel = srcKind === 'redis' ? 'Key pattern (scope)' : srcKind === 'kafka' ? 'Topic (scope)' : 'Table (scope)'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit link' : `Create link from ${srcKind} (${initialScope})`}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {(isEdit || srcKind === 'redis') && (
            <div className="space-y-1">
              <label className={labelClass}>{scopeLabel}</label>
              <input value={scopeInput} onChange={(event) => setScopeInput(event.target.value)} placeholder="scope" className={inputClass} />
            </div>
          )}
          {srcKind === 'redis' && (
            <div className="space-y-1">
              <label className={labelClass}>Extract value from</label>
              <Select value={redisExtract} onValueChange={(value) => setRedisExtract(value as RedisExtract)}>
                <SelectTrigger className="h-8 font-mono text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="value_field" className="font-mono text-xs">value field (hash / JSON path)</SelectItem>
                  <SelectItem value="key_capture" className="font-mono text-xs">key capture (the * in the pattern)</SelectItem>
                  <SelectItem value="string_value" className="font-mono text-xs">whole string value</SelectItem>
                  <SelectItem value="member" className="font-mono text-xs">collection element (set/zset/list member, hash value)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {needsSourceField && (
            <div className="space-y-1">
              <label className={labelClass}>{srcKind === 'postgres' ? 'Source column' : 'Source field'}</label>
              {fieldControl(sourceField, setSourceField, srcKind === 'postgres' ? 'Pick a column' : 'Field name / JSON path')}
            </div>
          )}

          <div className="space-y-1">
            <label className={labelClass}>Target connection</label>
            <Select value={targetConnId} onValueChange={setTargetConnId}>
              <SelectTrigger className="h-8 font-mono text-xs">
                <SelectValue placeholder="Pick a connection" />
              </SelectTrigger>
              <SelectContent>
                {targetOptions.map((conn) => (
                  <SelectItem key={conn.id} value={conn.id} className="font-mono text-xs">
                    {conn.name} ({conn.type})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {targetKind === 'redis' && (
            <div className="space-y-1">
              <label className={labelClass}>Key pattern (one *)</label>
              <input value={keyPattern} onChange={(event) => setKeyPattern(event.target.value)} placeholder="w:*" className={inputClass} />
            </div>
          )}
          {targetKind === 'postgres' && (
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className={labelClass}>Table</label>
                <input value={table} onChange={(event) => setTable(event.target.value)} placeholder="public.users" className={inputClass} />
              </div>
              <div className="space-y-1">
                <label className={labelClass}>Column</label>
                <input value={column} onChange={(event) => setColumn(event.target.value)} placeholder="id" className={inputClass} />
              </div>
            </div>
          )}
          {targetKind === 'kafka' && (
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className={labelClass}>Topic</label>
                <input value={targetTopic} onChange={(event) => setTargetTopic(event.target.value)} placeholder="example_topic" className={inputClass} />
              </div>
              <div className="space-y-1">
                <label className={labelClass}>Search field</label>
                <input value={targetSearchField} onChange={(event) => setTargetSearchField(event.target.value)} placeholder="user_id" className={inputClass} />
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="button" size="sm" disabled={invalid} onClick={() => void handleSave()}>
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
