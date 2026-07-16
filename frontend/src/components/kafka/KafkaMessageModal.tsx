import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { KafkaMessageDetail } from '@/components/kafka/KafkaMessageDetail'
import type { KafkaMessageRow } from '@/stores/kafka'

interface KafkaMessageModalProps {
  message: KafkaMessageRow | null
  onClose: () => void
}

export function KafkaMessageModal({ message, onClose }: KafkaMessageModalProps) {
  return (
    <Dialog
      open={message !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose()
        }
      }}
    >
      <DialogContent className="max-w-4xl gap-2 p-0">
        {message && (
          <>
            <DialogHeader className="px-4 pt-4">
              <DialogTitle className="font-mono text-sm font-medium">
                Message · partition {message.partition} · offset {message.offset}
              </DialogTitle>
            </DialogHeader>
            {/* Remount the detail per message so the Raw/Formatted toggle resets. */}
            <KafkaMessageDetail key={`${message.partition}:${message.offset}`} message={message} tall />
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
