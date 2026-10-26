import { Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { PALETTE_SHORTCUT, useCommandPaletteStore } from '@/stores/commandPalette'

// The visible door to the palette: the shortcut is the fast way in, but nobody
// finds a shortcut they were never shown. The key hint sits on the button so
// every click also teaches it.
export function CommandPaletteTrigger({ compact = false }: { compact?: boolean }) {
  const setOpen = useCommandPaletteStore((state) => state.setOpen)

  if (compact) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`Go to… (${PALETTE_SHORTCUT})`}
        aria-label="Go to connection, table or topic"
        className="flex items-center gap-1 rounded px-1.5 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <Search className="h-4 w-4" />
        <kbd className="font-mono text-[10px] leading-none text-muted-foreground/70">{PALETTE_SHORTCUT}</kbd>
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label="Go to connection, table or topic"
      className={cn(
        'group flex h-8 w-56 items-center gap-2 rounded-sm border border-border px-2.5 text-xs text-muted-foreground',
        'transition-colors duration-200 hover:border-amber-500/50 hover:text-foreground'
      )}
    >
      <Search className="h-3.5 w-3.5 shrink-0" />
      <span className="flex-1 text-left">Go to…</span>
      <kbd className="rounded-sm border border-border/80 bg-muted/30 px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground/80 group-hover:border-amber-500/30">
        {PALETTE_SHORTCUT}
      </kbd>
    </button>
  )
}
