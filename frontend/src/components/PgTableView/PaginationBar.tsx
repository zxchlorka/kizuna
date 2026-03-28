import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface PaginationBarProps {
  offset: number
  limit: number
  total: number
  onPrev: () => void
  onNext: () => void
}

export function PaginationBar({ offset, limit, total, onPrev, onNext }: PaginationBarProps) {
  const isPrevDisabled = offset === 0
  const isNextDisabled = offset + limit >= total

  const currentPage = total === 0 ? 0 : Math.floor(offset / limit) + 1
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit)

  const startRow = total === 0 ? 0 : offset + 1
  const endRow = Math.min(offset + limit, total)

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
        {total === 0 ? 'No rows' : `Showing ${startRow}–${endRow} of ${total.toLocaleString()} rows`}
      </span>
    </div>
  )
}
