import { useEffect, useMemo, useState } from 'react'
import { Link2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { LinkPickerDialog } from '@/components/links/LinkPickerDialog'
import { connectionLinks, linkSummary } from '@/lib/links'
import { useConnectionStore } from '@/stores/connections'
import { useLinksStore } from '@/stores/links'

interface ConnectionLinksButtonProps {
  connId: string
}

/**
 * Everything this connection is wired to, listed once at the connection level.
 *
 * It used to hang off the bottom of every object's own link menu, which put a
 * list about the whole server in front of someone asking about one key: most of
 * it could not be followed from there, and it buried the one or two links that
 * could. Here it is reference material sitting where the rest of the
 * connection-wide facts are, and an object's menu is only about that object.
 */
export function ConnectionLinksButton({ connId }: ConnectionLinksButtonProps) {
  const links = useLinksStore((state) => state.links)
  const fetchLinks = useLinksStore((state) => state.fetch)
  const connections = useConnectionStore((state) => state.connections)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    void fetchLinks().catch(() => undefined)
  }, [fetchLinks])

  const connectionName = (id: string) => connections.find((item) => item.id === id)?.name ?? id
  const items = useMemo(
    () =>
      connectionLinks(links, connId).map((link) => ({
        id: link.id,
        // Reference only: a link is followed from the value it starts at, and
        // there is no value at the connection level to follow one with.
        label: linkSummary(link, connectionName),
        disabled: true,
        onPick: () => undefined,
      })),
    // connectionName reads `connections`, which is the dependency that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [links, connId, connections]
  )

  if (items.length === 0) {
    return null
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-8 shrink-0 gap-1.5 font-mono text-[11px]"
        onClick={() => setOpen(true)}
        title="Every cross-source link on this connection"
      >
        <Link2 className="h-3.5 w-3.5" />
        {items.length}
      </Button>
      <LinkPickerDialog
        open={open}
        onOpenChange={setOpen}
        title={`Links on ${connectionName(connId)}`}
        items={items}
      />
    </>
  )
}
