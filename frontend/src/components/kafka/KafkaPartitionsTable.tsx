import { EmptyState } from '@/components/EmptyState'
import type { ObjectItem } from '@/types/api'

function metaNumber(item: ObjectItem, key: string): number {
  const value = item.meta?.[key]
  return typeof value === 'number' ? value : 0
}

export function KafkaPartitionsTable({ partitions }: { partitions: ObjectItem[] }) {
  if (partitions.length === 0) {
    return <EmptyState variant="no_tables" compact title="No partitions" description="The topic metadata returned no partitions." />
  }

  return (
    <div className="overflow-x-auto rounded-sm border border-border/70">
      <table className="min-w-full divide-y divide-border text-sm">
        <thead className="bg-muted/30 text-left text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          <tr>
            <th className="px-3 py-2">Partition</th>
            <th className="px-3 py-2">Messages</th>
            <th className="px-3 py-2">Start offset</th>
            <th className="px-3 py-2">End offset</th>
            <th className="px-3 py-2">Leader</th>
            <th className="px-3 py-2">Replicas</th>
            <th className="px-3 py-2">ISR</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60 font-mono text-xs">
          {partitions.map((partition) => (
            <tr key={partition.name}>
              <td className="px-3 py-2">{partition.name}</td>
              <td className="px-3 py-2">{partition.row_count.toLocaleString()}</td>
              <td className="px-3 py-2 text-muted-foreground">{metaNumber(partition, 'start_offset').toLocaleString()}</td>
              <td className="px-3 py-2 text-muted-foreground">{metaNumber(partition, 'end_offset').toLocaleString()}</td>
              <td className="px-3 py-2">{metaNumber(partition, 'leader')}</td>
              <td className="px-3 py-2">{metaNumber(partition, 'replicas')}</td>
              <td className="px-3 py-2">{metaNumber(partition, 'isr')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
