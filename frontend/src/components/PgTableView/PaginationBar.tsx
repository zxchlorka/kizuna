import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface PaginationBarProps {
  offset: number
  limit: number
  total: number
  hasMore: boolean
  onPrev: () => void
  onNext: () => void
}

export function PaginationBar({ offset, limit, total, hasMore, onPrev, onNext }: PaginationBarProps) {
  const isPrevDisabled = offset === 0
  // `hasMore` (derived from a LIMIT+1 probe) is the authoritative "is there a
  // next page" signal. `total` may be an approximate row estimate, so it must
  // not gate the Next button or it can stay enabled past the real last page.
  const isNextDisabled = !hasMore

  const currentPage = total === 0 ? 0 : Math.floor(offset / limit) + 1
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit)

  const startRow = total === 0 ? 0 : offset + 1
  const endRow = hasMore ? offset + limit : Math.min(offset + limit, total)
  const totalLabel = hasMore ? `${total.toLocaleString()}+` : total.toLocaleString()

  return (
    <div className="flex items-center justify-between gap-4 border-t border-border bg-background px-3 py-1.5">
      {/* Prev / Next */}
      <div className="flex items-center gap-1.5">
        <Button
          variant="outline"
          size="sm"
          onClick={onPrev}
          disabled={isPrevDisabled}
          className="h-7 w-7 p-0"
          aria-label="Previous page"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>

        <span className="text-xs text-muted-foreground tabular-nums">
          Page {currentPage} of {totalPages}
        </span>

        <Button
          variant="outline"
          size="sm"
          onClick={onNext}
          disabled={isNextDisabled}
          className="h-7 w-7 p-0"
          aria-label="Next page"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      {/* Row summary */}
      <span className="text-xs text-muted-foreground tabular-nums">
        {total === 0 ? 'No rows' : `Showing ${startRow}–${endRow} of ${totalLabel} rows`}
      </span>
    </div>
  )
}
