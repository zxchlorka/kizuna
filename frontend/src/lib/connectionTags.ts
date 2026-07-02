import { cn } from '@/lib/utils'

export function getConnectionTagClass(tag: string) {
  const normalized = tag.trim().toLowerCase()

  if (normalized === 'production' || normalized === 'prod') {
    return cn(
      'border-red-500/40 bg-red-500/14 text-red-300',
      'shadow-[inset_0_0_0_1px_rgba(239,68,68,0.08)]'
    )
  }

  if (normalized === 'development' || normalized === 'dev') {
    return cn(
      'border-sky-500/35 bg-sky-500/12 text-sky-300',
      'shadow-[inset_0_0_0_1px_rgba(14,165,233,0.08)]'
    )
  }

  if (normalized === 'staging' || normalized === 'stage') {
    return cn(
      'border-violet-500/35 bg-violet-500/12 text-violet-300',
      'shadow-[inset_0_0_0_1px_rgba(139,92,246,0.08)]'
    )
  }

  return 'border-border/90 bg-muted/35 text-foreground/80'
}
