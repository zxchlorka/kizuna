import { Fragment, useEffect, useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

interface KafkaFieldPathPickerProps {
  open: boolean
  rootValue: Record<string, unknown>
  value: string
  onChange: (path: string) => void
}

type JSONRecord = Record<string, unknown>

function isJSONObject(value: unknown): value is JSONRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function resolvePath(rootValue: JSONRecord, path: string[]): unknown {
  let current: unknown = rootValue
  for (const part of path) {
    if (!isJSONObject(current)) {
      return undefined
    }
    current = current[part]
  }
  return current
}

function entryDescription(value: unknown): string {
  if (isJSONObject(value)) {
    return 'object'
  }
  if (Array.isArray(value)) {
    return 'array — not supported'
  }
  if (value === null) {
    return 'null — not supported'
  }
  return typeof value
}

export function KafkaFieldPathPicker({ open, rootValue, value, onChange }: KafkaFieldPathPickerProps) {
  const [path, setPath] = useState<string[]>([])

  useEffect(() => {
    if (open) {
      setPath([])
    }
  }, [open, rootValue])

  const currentValue = useMemo(() => resolvePath(rootValue, path), [path, rootValue])
  const entries = useMemo(
    () => (isJSONObject(currentValue) ? Object.entries(currentValue).sort(([left], [right]) => left.localeCompare(right)) : []),
    [currentValue]
  )
  const selected = isScalar(currentValue) && value === path.join('.')

  const moveToPath = (nextPath: string[]) => {
    setPath(nextPath)
    onChange('')
  }

  const handleSelect = (key: string) => {
    if (!isJSONObject(currentValue)) {
      return
    }
    const nextValue = currentValue[key]
    const nextPath = [...path, key]
    if (isJSONObject(nextValue)) {
      moveToPath(nextPath)
      return
    }
    if (isScalar(nextValue)) {
      setPath(nextPath)
      onChange(nextPath.join('.'))
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1 font-mono text-[11px]">
        <button
          type="button"
          onClick={() => moveToPath([])}
          disabled={path.length === 0}
          className="rounded-sm px-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-default disabled:hover:bg-transparent"
        >
          message
        </button>
        {path.map((part, index) => (
          <Fragment key={`${part}-${index}`}>
            <ChevronRight className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
            {index === path.length - 1 ? (
              <span className="rounded-sm bg-muted px-1 text-foreground">{part}</span>
            ) : (
              <button
                type="button"
                onClick={() => moveToPath(path.slice(0, index + 1))}
                className="rounded-sm px-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {part}
              </button>
            )}
          </Fragment>
        ))}
      </div>

      {selected ? (
        <div className="flex items-center justify-between gap-3 rounded-sm border border-orange-500/30 bg-orange-500/5 px-2 py-2">
          <span className="font-mono text-xs text-foreground">Selected scalar field</span>
          <button
            type="button"
            onClick={() => moveToPath(path.slice(0, -1))}
            className="font-mono text-[11px] text-orange-600 transition-colors hover:text-orange-500 dark:text-orange-400"
          >
            Change
          </button>
        </div>
      ) : entries.length > 0 ? (
        <Select onValueChange={handleSelect}>
          <SelectTrigger className="h-8 font-mono text-xs">
            <SelectValue placeholder={path.length === 0 ? 'Pick a field' : `Pick a field in ${path.join('.')}`} />
          </SelectTrigger>
          <SelectContent>
            {entries.map(([key, entryValue]) => {
              const unsupported = Array.isArray(entryValue) || entryValue === null || key.includes('.')
              const description = key.includes('.') ? 'key contains . — not supported' : entryDescription(entryValue)
              return (
                <SelectItem key={key} value={key} disabled={unsupported} className="font-mono text-xs">
                  {key} <span className="text-muted-foreground">· {description}</span>
                </SelectItem>
              )
            })}
          </SelectContent>
        </Select>
      ) : (
        <p className="rounded-sm border border-border bg-muted/10 px-2 py-2 font-mono text-[11px] text-muted-foreground">
          This object has no selectable scalar fields.
        </p>
      )}

      {!selected && (
        <p className="text-[11px] text-muted-foreground">
          Objects open the next level. Arrays and null values cannot be used as link fields.
        </p>
      )}
    </div>
  )
}
