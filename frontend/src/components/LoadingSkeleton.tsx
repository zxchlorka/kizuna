import { Skeleton } from '@/components/ui/skeleton'

interface LoadingSkeletonProps {
  variant: 'table' | 'tree' | 'connections'
}

export function LoadingSkeleton({ variant }: LoadingSkeletonProps) {
  if (variant === 'tree') {
    return (
      <div className="space-y-2 py-2">
        {[...Array(3)].map((_, index) => (
          <div key={index} className="flex items-center gap-2 px-2">
            <Skeleton className="h-4 w-4" />
            <Skeleton className="h-4 flex-1" />
          </div>
        ))}
      </div>
    )
  }

  if (variant === 'connections') {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[...Array(2)].map((_, index) => (
          <div key={index} className="rounded-sm border border-border bg-card p-4">
            <div className="flex items-start gap-3">
              <Skeleton className="h-8 w-8 rounded-sm" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
            <div className="mt-4 flex items-center justify-between">
              <Skeleton className="h-5 w-16" />
              <Skeleton className="h-3 w-12" />
            </div>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-1">
      <div className="flex gap-1">
        {[...Array(5)].map((_, index) => (
          <Skeleton key={index} className="h-9 flex-1" />
        ))}
      </div>
      {[...Array(5)].map((_, rowIndex) => (
        <div key={rowIndex} className="flex gap-1">
          {[...Array(5)].map((_, columnIndex) => (
            <Skeleton key={columnIndex} className="h-8 flex-1" />
          ))}
        </div>
      ))}
    </div>
  )
}
