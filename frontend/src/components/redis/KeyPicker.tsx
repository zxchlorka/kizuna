import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAutocomplete } from '@/hooks/useAutocomplete'
import { cn } from '@/lib/utils'

/**
 * Naming a Redis key without typing it.
 *
 * Real keys are `profile:019ec4d4-767b-7bf0-ac78-7d219e2c742d` — nobody types
 * that, and nobody remembers it either. Two ways in, because people arrive with
 * the key in different places:
 *
 *   - type a prefix and pick from what the server finds (SCAN MATCH, capped);
 *   - paste a list — from a log, a terminal, a colleague's message — and every
 *     line, comma or space becomes a key.
 */

const DEBOUNCE_MS = 180
const MAX_SUGGESTIONS = 8

interface KeyPickerProps {
  connId: string
  /** Already chosen, so the list can skip them. */
  taken: string[]
  disabled?: boolean
  onPick: (keys: string[]) => void
}

/**
 * Splits pasted text into key names. A list copied from anywhere real arrives
 * separated by newlines, commas or spaces, and a key itself never contains
 * whitespace — so all three can be treated as separators.
 */
export function parseKeyList(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((part) => part.trim().replace(/^["']|["']$/g, ''))
    .filter((part) => part !== '')
}

export function KeyPicker({ connId, taken, disabled, onPick }: KeyPickerProps) {
  const complete = useAutocomplete(connId)
  const [draft, setDraft] = useState('')
  const [options, setOptions] = useState<string[]>([])
  const [highlight, setHighlight] = useState(0)
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const query = draft.trim()
    if (query === '') {
      setOptions([])
      return
    }

    // Debounced and abortable: every keystroke would otherwise start a SCAN on
    // the server, and the answers could arrive out of order.
    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      try {
        const items = await complete({ prefix: query, context: 'key' }, controller.signal)
        const labels = items.map((item) => item.label).filter((label) => !taken.includes(label)).slice(0, MAX_SUGGESTIONS)
        setOptions(labels)
        setHighlight(0)
        // Nothing to choose between when the only match is what is already
        // typed — and the list would sit over the button you want next.
        setOpen(!(labels.length === 1 && labels[0] === query))
      } catch {
        // A cancelled or failed lookup leaves typing alone: the field still
        // accepts a name nobody suggested.
        setOptions([])
      }
    }, DEBOUNCE_MS)

    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [draft, complete, taken])

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  const take = (keys: string[]) => {
    const fresh = keys.filter((key) => !taken.includes(key))
    if (fresh.length > 0) onPick(fresh)
    setDraft('')
    setOptions([])
    setOpen(false)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!open || options.length === 0) {
      if (event.key === 'Enter') {
        event.preventDefault()
        take(parseKeyList(draft))
      }
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlight((current) => (current + 1) % options.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlight((current) => (current - 1 + options.length) % options.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      take([options[highlight]])
    } else if (event.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div ref={boxRef} className="relative flex items-center gap-2">
      <Input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => options.length > 0 && setOpen(true)}
        // Pasting a list is one gesture rather than one-by-one: the text lands
        // as keys instead of as a single impossible name.
        // A pasted key is a key, not a draft: it goes straight in. Leaving it
        // in the field made the suggestion list reopen on top of the Compare
        // button, so the one gesture that should have been fastest ended in a
        // dropdown covering the thing you were reaching for.
        onPaste={(event) => {
          const keys = parseKeyList(event.clipboardData.getData('text'))
          if (keys.length > 0) {
            event.preventDefault()
            take(keys)
          }
        }}
        placeholder="type a prefix, or paste a list of keys"
        className="h-8 font-mono text-xs"
        aria-label="Key to compare with"
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
      />
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-8 shrink-0 gap-1.5 font-mono text-[11px]"
        onClick={() => take(parseKeyList(draft))}
        disabled={disabled || draft.trim() === ''}
      >
        <Plus className="h-3.5 w-3.5" />
        Add
      </Button>

      {open && options.length > 0 && (
        <div className="absolute left-0 right-20 top-9 z-50 max-h-56 overflow-auto rounded-sm border border-border bg-popover shadow-lg">
          {options.map((option, index) => (
            <button
              key={option}
              type="button"
              onMouseEnter={() => setHighlight(index)}
              onClick={() => take([option])}
              className={cn(
                'block w-full truncate px-2 py-1.5 text-left font-mono text-xs',
                index === highlight ? 'bg-amber-500/15 text-amber-600 dark:text-amber-500' : 'hover:bg-muted/60'
              )}
            >
              {option}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
