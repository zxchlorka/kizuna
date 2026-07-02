import { useState } from 'react'
import { Bomb } from 'lucide-react'
import { BulkDeleteDialog } from '@/components/redis/BulkDeleteDialog'
import { Button } from '@/components/ui/button'
import { useDataStore } from '@/stores/data'
import { useToastStore } from '@/stores/toast'
import { useWorkspaceStore } from '@/stores/workspace'

interface BulkActionsProps {
  connId: string
}

export function BulkActions({ connId }: BulkActionsProps) {
  const mutateBulk = useDataStore((state) => state.mutateBulk)
  const refreshTree = useWorkspaceStore((state) => state.refreshTree)
  const pushToast = useToastStore((state) => state.push)

  const [open, setOpen] = useState(false)
  const [pattern, setPattern] = useState('cache:*')
  const [previewCount, setPreviewCount] = useState<number | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const runPreview = async () => {
    setPreviewing(true)
    try {
      const result = await mutateBulk(connId, {
        schema: '',
        object: '',
        operations: [],
        pattern,
        preview: true,
        confirm_all: pattern.trim() === '*',
      }, `redis-bulk:${connId}`)
      setPreviewCount(result.applied)
    } catch (error) {
      pushToast({
        tone: 'error',
        title: 'Bulk preview failed',
        message: (error as Error).message,
      })
    } finally {
      setPreviewing(false)
    }
  }

  const runDelete = async () => {
    setDeleting(true)
    try {
      const result = await mutateBulk(connId, {
        schema: '',
        object: '',
        operations: [],
        pattern,
        execute: true,
        confirm_all: pattern.trim() === '*',
      }, `redis-bulk:${connId}`)
      await refreshTree(connId)
      setPreviewCount(result.rows_affected)
      pushToast({
        tone: 'success',
        title: 'Bulk delete complete',
        message: result.message,
      })
      setOpen(false)
    } catch (error) {
      pushToast({
        tone: 'error',
        title: 'Bulk delete failed',
        message: (error as Error).message,
      })
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <Button type="button" size="sm" variant="outline" className="h-7 gap-1.5 px-2 font-mono text-[10px]" onClick={() => setOpen(true)}>
        <Bomb className="h-3.5 w-3.5" />
        Bulk Actions
      </Button>

      <BulkDeleteDialog
        open={open}
        pattern={pattern}
        previewCount={previewCount}
        previewing={previewing}
        deleting={deleting}
        onPatternChange={(value) => {
          setPattern(value)
          setPreviewCount(null)
        }}
        onPreview={() => void runPreview()}
        onDelete={() => void runDelete()}
        onOpenChange={setOpen}
      />
    </>
  )
}
