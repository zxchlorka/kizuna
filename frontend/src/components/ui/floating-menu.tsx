import { useEffect, type ReactNode } from 'react'

interface FloatingMenuProps {
  x: number
  y: number
  onClose: () => void
  children: ReactNode
}

// FloatingMenu renders a positioned menu at (x, y). A full-screen transparent
// backdrop closes it on outside click; Escape also closes it.
export function FloatingMenu({ x, y, onClose, children }: FloatingMenuProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50" onClick={onClose} onContextMenu={(event) => event.preventDefault()}>
      <div
        className="absolute min-w-56 overflow-hidden rounded-sm border border-border bg-popover py-1 text-popover-foreground shadow-md"
        style={{ left: x, top: y }}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}

interface FloatingMenuItemProps {
  disabled?: boolean
  onClick?: () => void
  children: ReactNode
}

export function FloatingMenuItem({ disabled, onClick, children }: FloatingMenuItemProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  )
}

export function FloatingMenuLabel({ children }: { children: ReactNode }) {
  return <div className="px-3 py-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{children}</div>
}

export function FloatingMenuSeparator() {
  return <div className="my-1 h-px bg-border" />
}
