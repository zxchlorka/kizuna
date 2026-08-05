import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

interface FloatingMenuProps {
  x: number
  y: number
  onClose: () => void
  children: ReactNode
}

// Breathing room between the menu and the window edge when it has to be pulled
// back inside.
const VIEWPORT_MARGIN = 8

// FloatingMenu renders a positioned menu at (x, y). A full-screen transparent
// backdrop closes it on outside click; Escape also closes it.
export function FloatingMenu({ x, y, onClose, children }: FloatingMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState({ left: x, top: y })

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Right-clicking near an edge would otherwise render the menu off-screen: it
  // is placed at the cursor and grows right and down. Measured after layout
  // because the size depends on the content -- link labels carry connection
  // names, so it varies per menu. Height is capped by maxHeight below, so a
  // menu taller than the window lands at VIEWPORT_MARGIN and scrolls.
  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) {
      return
    }
    const { width, height } = menu.getBoundingClientRect()
    setPosition({
      left: Math.max(VIEWPORT_MARGIN, Math.min(x, window.innerWidth - width - VIEWPORT_MARGIN)),
      top: Math.max(VIEWPORT_MARGIN, Math.min(y, window.innerHeight - height - VIEWPORT_MARGIN)),
    })
  }, [x, y, children])

  return (
    <div className="fixed inset-0 z-50" onClick={onClose} onContextMenu={(event) => event.preventDefault()}>
      <div
        ref={menuRef}
        // max-w держит меню в узде независимо от данных: значение линка может
        // быть в килобайты длиной, и без этого меню растягивается на весь экран.
        className="absolute min-w-56 max-w-[36rem] overflow-x-hidden overflow-y-auto rounded-sm border border-border bg-popover py-1 text-popover-foreground shadow-md"
        // maxHeight парный к max-w: меню с несколькими группами (PG, Kafka) бывает
        // выше окна, и без него нижние пункты недостижимы -- клампинг позиции
        // упирает меню в верхний край, а низ уходит за экран без прокрутки.
        style={{
          left: position.left,
          top: position.top,
          maxHeight: `calc(100vh - ${VIEWPORT_MARGIN * 2}px)`,
        }}
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
      {/* Ширина меню не должна зависеть от длины значения: метка обрезается
          многоточием, полный текст доступен в LinkPickerDialog. */}
      <span className="block min-w-0 max-w-[32rem] truncate">{children}</span>
    </button>
  )
}

export function FloatingMenuLabel({ children }: { children: ReactNode }) {
  return (
    <div className="truncate px-3 py-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{children}</div>
  )
}

export function FloatingMenuSeparator() {
  return <div className="my-1 h-px bg-border" />
}
