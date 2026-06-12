import { useCallback, useEffect, useRef } from 'react'
import type { CompletionItem } from '@/types/api'

type CompletionContext = 'table' | 'column' | 'function' | 'keyword' | 'command' | 'key'

interface CompletionRequest {
  prefix: string
  context: CompletionContext
  table?: string
}

export function useAutocomplete(connId: string) {
  const connIdRef = useRef(connId)

  useEffect(() => {
    connIdRef.current = connId
  }, [connId])

  return useCallback(async ({ prefix, context, table }: CompletionRequest, signal?: AbortSignal): Promise<CompletionItem[]> => {
    const params = new URLSearchParams({
      prefix,
      context,
    })
    if (table) {
      params.set('table', table)
    }

    const res = await fetch(`/api/connections/${connIdRef.current}/completions?${params.toString()}`, {
      signal,
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error(body.error || res.statusText)
    }
    return (await res.json()) as CompletionItem[]
  }, [])
}
