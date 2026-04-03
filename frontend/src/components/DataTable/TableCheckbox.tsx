import { useEffect, useRef } from 'react'
import { Check, Minus } from 'lucide-react'
import { cn } from '@/lib/utils'

interface TableCheckboxProps {
  checked: boolean
  indeterminate?: boolean
  disabled?: boolean
  className?: string
  onChange?: (checked: boolean) => void
}

export function TableCheckbox({
  checked,
  indeterminate = false,
  disabled = false,
  className,
  onChange,
}: TableCheckboxProps) {
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!ref.current) return
    ref.current.indeterminate = indeterminate && !checked
  }, [checked, indeterminate])

  const showMark = checked || indeterminate

  return (
    <span className={cn('relative inline-flex h-5 w-5 shrink-0 items-center justify-center', className)}>
      <input
        ref={ref}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.checked)}
        className={cn(
          'm-0 h-5 w-5 shrink-0 appearance-none rounded-md border-2 border-muted-foreground/40 bg-transparent transition-colors',
          'hover:border-muted-foreground/70',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
          'checked:border-primary checked:bg-primary',
          disabled && 'cursor-not-allowed opacity-60',
          !disabled && 'cursor-pointer'
        )}
      />
      {showMark && (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-primary-foreground">
          {indeterminate && !checked ? <Minus className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
        </span>
      )}
    </span>
  )
}
