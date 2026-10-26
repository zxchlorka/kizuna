import { create } from 'zustand'

interface CommandPaletteStore {
  open: boolean
  setOpen: (open: boolean) => void
  toggle: () => void
}

export const useCommandPaletteStore = create<CommandPaletteStore>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((state) => ({ open: !state.open })),
}))

export const PALETTE_SHORTCUT =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘K' : 'Ctrl K'
