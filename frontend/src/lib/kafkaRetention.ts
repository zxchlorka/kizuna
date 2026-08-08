import { formatBytes, formatDurationSeconds } from '@/lib/numberFormat'

// Kafka enforces retention.bytes per partition, not per topic. Reading it as a
// topic-wide ceiling understates the real one by a factor of the partition
// count — a 250 GB limit on a 12-partition topic bounds it at ~2.7 TiB, not
// 233 GiB. Both numbers are rendered so the per-partition value can never be
// mistaken for the topic's total.
export interface RetentionSize {
  // Per-partition limit as configured, or null when the topic has no size limit.
  perPartition: string | null
  // Per-partition limit multiplied by the partition count. Null when there is
  // no limit, or when the partition count is unknown and the product would be
  // a guess.
  topicTotal: string | null
  note: string
}

// Kafka spells "no limit" as -1 for both retention configs.
const UNLIMITED = -1

function parseConfig(value: string | undefined): number | null {
  if (value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function describeRetentionSize(value: string | undefined, partitions: number): RetentionSize {
  const bytes = parseConfig(value)

  if (bytes === null) {
    return { perPartition: null, topicTotal: null, note: 'Not reported by the broker' }
  }
  if (bytes < 0) {
    return {
      perPartition: null,
      topicTotal: null,
      note: 'No size limit — this topic is trimmed by time alone',
    }
  }
  if (!Number.isInteger(partitions) || partitions < 1) {
    return {
      perPartition: formatBytes(bytes),
      topicTotal: null,
      note: 'Per partition — the topic-wide ceiling needs the partition count',
    }
  }

  return {
    perPartition: formatBytes(bytes),
    topicTotal: formatBytes(bytes * partitions),
    note: `Per partition. Across ${partitions} partition${partitions === 1 ? '' : 's'} the topic can hold ${formatBytes(
      bytes * partitions
    )}.`,
  }
}

// retention.ms is a topic-wide age limit, so unlike retention.bytes it means
// exactly what it reads as.
export function describeRetentionTime(value: string | undefined): string {
  const ms = parseConfig(value)
  if (ms === null) return 'Not reported by the broker'
  if (ms === UNLIMITED || ms < 0) return 'Kept forever — no time limit'
  if (ms === 0) return 'Deleted immediately'
  return formatDurationSeconds(ms / 1000)
}
