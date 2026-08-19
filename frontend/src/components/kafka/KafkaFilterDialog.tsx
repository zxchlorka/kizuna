import { ListTree, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { conditionTarget } from '@/stores/kafka'
import type { KafkaMatchCondition, KafkaMatchMode, KafkaMatchOp, KafkaMatchTarget } from '@/stores/kafka'

interface KafkaFilterDialogProps {
  open: boolean
  conditions: KafkaMatchCondition[]
  mode: KafkaMatchMode
  onOpenChange: (open: boolean) => void
  onConditionsChange: (conditions: KafkaMatchCondition[]) => void
  onModeChange: (mode: KafkaMatchMode) => void
  // Opens the sampled-message field picker for one row.
  onPickField: (index: number) => void
}

export const emptyCondition: KafkaMatchCondition = { field: '', value: '', op: 'eq' }

// Only equals and contains compare against typed text; presence ops read the
// field alone.
const takesValue = (op: KafkaMatchOp): boolean => op === 'eq' || op === 'contains'

export function KafkaFilterDialog({
  open,
  conditions,
  mode,
  onOpenChange,
  onConditionsChange,
  onModeChange,
  onPickField,
}: KafkaFilterDialogProps) {
  const rows = conditions.length > 0 ? conditions : [emptyCondition]

  const update = (index: number, patch: Partial<KafkaMatchCondition>) => {
    onConditionsChange(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">Message filters</DialogTitle>
          <DialogDescription className="font-mono text-xs">
            Each condition tests the record key, one of its headers, or a JSON path in its value. They apply both to
            the loaded messages and to a topic scan.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Match</span>
          {(['and', 'or'] as const).map((option) => (
            <Button
              key={option}
              type="button"
              size="sm"
              variant={mode === option ? 'secondary' : 'outline'}
              className="h-7 px-3 font-mono text-[11px]"
              onClick={() => onModeChange(option)}
              title={
                option === 'and'
                  ? 'A message must satisfy every condition'
                  : 'A message must satisfy at least one condition'
              }
            >
              {option === 'and' ? 'All conditions' : 'Any condition'}
            </Button>
          ))}
        </div>

        <div className="flex max-h-[50vh] flex-col gap-2 overflow-y-auto">
          {rows.map((condition, index) => (
            <div key={index} className="flex flex-wrap items-center gap-2">
              <span className="w-8 shrink-0 font-mono text-[11px] text-muted-foreground">
                {index === 0 ? '' : mode === 'or' ? 'or' : 'and'}
              </span>
              <Select
                value={conditionTarget(condition)}
                onValueChange={(value) => update(index, { target: value as KafkaMatchTarget })}
              >
                <SelectTrigger
                  className="h-8 w-24 shrink-0 font-mono text-xs"
                  aria-label={`Where condition ${index + 1} looks`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="value" className="font-mono text-xs">
                    value
                  </SelectItem>
                  <SelectItem value="key" className="font-mono text-xs">
                    key
                  </SelectItem>
                  <SelectItem value="header" className="font-mono text-xs">
                    header
                  </SelectItem>
                </SelectContent>
              </Select>
              {/* The key is a single value with no name to give, so the field
                  box has nothing to hold for it. */}
              <input
                value={conditionTarget(condition) === 'key' ? '' : condition.field}
                onChange={(event) => update(index, { field: event.target.value })}
                placeholder={
                  conditionTarget(condition) === 'header'
                    ? 'header name'
                    : conditionTarget(condition) === 'key'
                      ? 'the record key'
                      : 'JSON path (e.g. events[].name)'
                }
                aria-label={`Field for condition ${index + 1}`}
                disabled={conditionTarget(condition) === 'key'}
                spellCheck={false}
                autoComplete="off"
                className="h-8 w-56 rounded-sm border border-border bg-background px-2 font-mono text-xs outline-none placeholder:text-muted-foreground focus:border-orange-500/50 disabled:cursor-not-allowed disabled:opacity-50"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                className={cn('h-8 w-8 shrink-0 p-0', conditionTarget(condition) !== 'value' && 'invisible')}
                onClick={() => onPickField(index)}
                title="Browse sampled messages and pick a field"
                aria-label={`Choose field for condition ${index + 1}`}
              >
                <ListTree className="h-3.5 w-3.5" />
              </Button>
              <Select value={condition.op} onValueChange={(value) => update(index, { op: value as KafkaMatchOp })}>
                <SelectTrigger className="h-8 w-32 font-mono text-xs" aria-label={`Match operator for condition ${index + 1}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="eq" className="font-mono text-xs">
                    equals
                  </SelectItem>
                  <SelectItem value="contains" className="font-mono text-xs">
                    contains
                  </SelectItem>
                  <SelectItem value="exists" className="font-mono text-xs">
                    {conditionTarget(condition) === 'value' ? 'has field' : 'is set'}
                  </SelectItem>
                  <SelectItem value="missing" className="font-mono text-xs">
                    {conditionTarget(condition) === 'value' ? 'no field' : 'is unset'}
                  </SelectItem>
                </SelectContent>
              </Select>
              <input
                value={takesValue(condition.op) ? condition.value : ''}
                onChange={(event) => update(index, { value: event.target.value })}
                placeholder={takesValue(condition.op) ? 'compared value' : 'not used'}
                aria-label={`Expected value for condition ${index + 1}`}
                disabled={!takesValue(condition.op)}
                spellCheck={false}
                autoComplete="off"
                className="h-8 w-44 rounded-sm border border-border bg-background px-2 font-mono text-xs outline-none placeholder:text-muted-foreground focus:border-orange-500/50 disabled:cursor-not-allowed disabled:opacity-50"
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className={cn('h-8 w-8 shrink-0 p-0', rows.length === 1 && 'invisible')}
                onClick={() => onConditionsChange(rows.filter((_, at) => at !== index))}
                title="Remove this condition"
                aria-label={`Remove condition ${index + 1}`}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 font-mono text-[11px]"
            onClick={() => onConditionsChange([...rows, { ...emptyCondition }])}
          >
            <Plus className="h-3.5 w-3.5" />
            Add condition
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="h-8 font-mono text-[11px]"
            onClick={() => onOpenChange(false)}
          >
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
