import { useEffect, useRef, useState } from 'react'
import { Folder } from 'lucide-react'
import { cn } from '@/lib/utils'

interface FolderNameInputProps {
  initial?: string
  placeholder?: string
  onSubmit: (name: string) => Promise<void>
  onCancel: () => void
}

// Inline name field for creating and renaming a folder: Enter or leaving the
// field saves, Escape or an empty name drops the edit.
export function FolderNameInput({ initial = '', placeholder = 'Folder name', onSubmit, onCancel }: FolderNameInputProps) {
  const [value, setValue] = useState(initial)
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Opened from a menu, autoFocus alone loses: the closing menu still holds
  // focus inside its own scope. Focusing a tick later lands after it lets go.
  useEffect(() => {
    const timer = window.setTimeout(() => inputRef.current?.focus())
    return () => window.clearTimeout(timer)
  }, [])

  const submit = async () => {
    const name = value.trim()
    if (saving) return
    if (!name || name === initial) {
      onCancel()
      return
    }
    setSaving(true)
    try {
      await onSubmit(name)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex h-8 items-center gap-2">
      <Folder className="h-4 w-4 shrink-0 text-amber-500" />
      <input
        ref={inputRef}
        autoFocus
        value={value}
        disabled={saving}
        maxLength={100}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void submit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit()
          if (e.key === 'Escape') onCancel()
        }}
        className={cn(
          'h-7 w-64 rounded-sm border border-amber-500/50 bg-card/60 px-2 font-mono text-sm',
          'placeholder:text-muted-foreground/60 focus-visible:outline-none'
        )}
      />
    </div>
  )
}
