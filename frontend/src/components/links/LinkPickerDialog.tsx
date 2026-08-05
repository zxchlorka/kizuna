import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

// Меню линков не должно зависеть от данных: один линк с многокилобайтным
// значением иначе растягивает его на весь экран. В меню показываем не больше
// LINK_MENU_CAP пунктов, остальное уходит в эту модалку.
export const LINK_MENU_CAP = 5

// The "what else is on this connection" group is reference material, not the
// thing you opened the menu for, so it gets a glance rather than a list. The
// full set is one click away in the dialog.
export const LINK_PREVIEW_CAP = 2

export interface LinkPickerItem {
  id: string
  label: string
  disabled?: boolean
  onPick: () => void
}

interface LinkPickerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  items: LinkPickerItem[]
}

export function LinkPickerDialog({ open, onOpenChange, title, items }: LinkPickerDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-1 overflow-y-auto">
          {items.length === 0 && <div className="px-2 py-3 text-xs text-muted-foreground">No links here yet.</div>}
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              disabled={item.disabled}
              onClick={() => {
                item.onPick()
                onOpenChange(false)
              }}
              // break-all, а не truncate: в модалке значение показывается
              // целиком — ровно за этим её и открывают.
              className="block w-full break-all rounded-sm px-2 py-2 text-left font-mono text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              {item.label}
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
