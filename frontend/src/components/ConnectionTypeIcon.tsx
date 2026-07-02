import { cn } from '@/lib/utils'
import type { ConnectionType } from '@/types/api'

interface ConnectionTypeIconProps {
  type: ConnectionType
  className?: string
}

export function ConnectionTypeIcon({ type, className }: ConnectionTypeIconProps) {
  if (type === 'kafka') {
    return (
      <svg
        viewBox="0 0 24 24"
        className={cn('text-orange-400', className)}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="6" cy="12" r="2.5" />
        <circle cx="17" cy="5.5" r="2.5" />
        <circle cx="17" cy="18.5" r="2.5" />
        <path d="M8.2 10.8 14.8 6.9" />
        <path d="M8.2 13.2 14.8 17.1" />
      </svg>
    )
  }

  if (type === 'redis') {
    return (
      <svg
        viewBox="0 0 24 24"
        className={cn('text-red-400', className)}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="4" y="4" width="16" height="4" rx="1.5" />
        <rect x="4" y="10" width="16" height="4" rx="1.5" />
        <rect x="4" y="16" width="16" height="4" rx="1.5" />
        <path d="M8 6H8.01" />
        <path d="M8 12H8.01" />
        <path d="M8 18H8.01" />
        <path d="M11 6H16" />
        <path d="M11 12H16" />
        <path d="M11 18H16" />
      </svg>
    )
  }

  return (
    <svg
      viewBox="0 0 24 24"
      className={cn('text-blue-400', className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5V19A9 3 0 0 0 21 19V5" />
      <path d="M3 12A9 3 0 0 0 21 12" />
    </svg>
  )
}
