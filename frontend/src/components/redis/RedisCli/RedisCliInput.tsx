import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import { autocompletion, completionKeymap, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, insertNewline } from '@codemirror/commands'
import { Compartment, EditorSelection, EditorState, type Extension } from '@codemirror/state'
import { EditorView, drawSelection, highlightActiveLine, keymap } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { useTheme } from 'next-themes'
import { useAutocomplete } from '@/hooks/useAutocomplete'
import type { CompletionItem } from '@/types/api'

export interface RedisCliInputHandle {
  focus: () => void
}

interface RedisCliInputProps {
  connId: string
  value: string
  onChange: (value: string) => void
  onRun: () => void
  onClear: () => void
  onHistoryNavigate: (direction: 'previous' | 'next') => void
}

function buildTheme(dark: boolean): Extension {
  return EditorView.theme(
    {
      '&': {
        height: '100%',
        fontSize: '13px',
        backgroundColor: 'transparent',
      },
      '.cm-scroller': {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      },
      '.cm-content': {
        padding: '10px 12px',
        caretColor: dark ? '#f8fafc' : '#0f172a',
      },
      '.cm-line': {
        paddingLeft: '6px',
      },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
        backgroundColor: dark ? 'rgba(56, 189, 248, 0.26)' : 'rgba(14, 165, 233, 0.18)',
      },
      '.cm-tooltip': {
        border: dark ? '1px solid rgba(30, 41, 59, 1)' : '1px solid rgba(203, 213, 225, 0.9)',
        backgroundColor: dark ? '#020617' : '#ffffff',
      },
    },
    { dark }
  )
}

function detectContext(text: string, cursor: number): { context: 'command' | 'key'; prefix: string; from: number } {
  const lineStart = text.lastIndexOf('\n', cursor - 1) + 1
  const before = text.slice(lineStart, cursor)
  const firstSpace = before.search(/\s/)
  if (firstSpace === -1) {
    return {
      context: 'command',
      prefix: before.trimStart(),
      from: cursor - before.trimStart().length,
    }
  }

  const trailing = before.slice(firstSpace + 1)
  const match = trailing.match(/([^\s]*)$/)
  const prefix = match?.[1] ?? ''
  return {
    context: 'key',
    prefix,
    from: cursor - prefix.length,
  }
}

async function createRedisCompletionResult(
  completionContext: CompletionContext,
  requestCompletions: ReturnType<typeof useAutocomplete>
): Promise<CompletionResult | null> {
  const doc = completionContext.state.doc.toString()
  const detected = detectContext(doc, completionContext.pos)
  if (!completionContext.explicit && detected.prefix.length === 0 && detected.context === 'key') {
    return null
  }

  const items = await requestCompletions({ prefix: detected.prefix, context: detected.context })
  if (items.length === 0) {
    return null
  }

  return {
    from: detected.from,
    options: items.map((item: CompletionItem) => ({
      label: item.label,
      detail: item.detail,
      type: item.type,
    })),
  }
}

export const RedisCliInput = forwardRef<RedisCliInputHandle, RedisCliInputProps>(function RedisCliInput(
  { connId, value, onChange, onRun, onClear, onHistoryNavigate },
  ref
) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const onRunRef = useRef(onRun)
  const onClearRef = useRef(onClear)
  const onHistoryNavigateRef = useRef(onHistoryNavigate)
  const requestCompletions = useAutocomplete(connId)
  const requestCompletionsRef = useRef(requestCompletions)
  const themeCompartment = useMemo(() => new Compartment(), [])
  const autocompleteCompartment = useMemo(() => new Compartment(), [])
  const { resolvedTheme } = useTheme()

  useEffect(() => {
    onChangeRef.current = onChange
    onRunRef.current = onRun
    onClearRef.current = onClear
    onHistoryNavigateRef.current = onHistoryNavigate
    requestCompletionsRef.current = requestCompletions
  }, [onChange, onClear, onHistoryNavigate, onRun, requestCompletions])

  useImperativeHandle(ref, () => ({
    focus: () => {
      viewRef.current?.focus()
    },
  }))

  useEffect(() => {
    if (!rootRef.current || viewRef.current) {
      return
    }

    const completionSource = (context: CompletionContext) => createRedisCompletionResult(context, requestCompletionsRef.current)
    const extensions: Extension[] = [
      basicSetup,
      history(),
      drawSelection(),
      highlightActiveLine(),
      keymap.of([
        {
          key: 'Enter',
          run: () => {
            onRunRef.current()
            return true
          },
        },
        {
          key: 'Shift-Enter',
          run: insertNewline,
        },
        {
          key: 'ArrowUp',
          run: (view) => {
            if (view.state.doc.lines === 1) {
              onHistoryNavigateRef.current('previous')
              return true
            }
            return false
          },
        },
        {
          key: 'ArrowDown',
          run: (view) => {
            if (view.state.doc.lines === 1) {
              onHistoryNavigateRef.current('next')
              return true
            }
            return false
          },
        },
        {
          key: 'Ctrl-l',
          run: () => {
            onClearRef.current()
            return true
          },
        },
        {
          key: 'Mod-l',
          run: () => {
            onClearRef.current()
            return true
          },
        },
        ...defaultKeymap,
        ...historyKeymap,
        ...completionKeymap,
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          onChangeRef.current(update.state.doc.toString())
        }
      }),
      themeCompartment.of(buildTheme(resolvedTheme === 'dark')),
      autocompleteCompartment.of(autocompletion({ override: [completionSource], activateOnTyping: true })),
    ]

    const state = EditorState.create({ doc: value, extensions })
    const view = new EditorView({ state, parent: rootRef.current })
    viewRef.current = view
    view.focus()

    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [autocompleteCompartment, resolvedTheme, themeCompartment, value])

  useEffect(() => {
    const view = viewRef.current
    if (!view) {
      return
    }
    const current = view.state.doc.toString()
    if (current === value) {
      return
    }
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      selection: EditorSelection.cursor(Math.min(value.length, view.state.selection.main.head)),
    })
  }, [value])

  useEffect(() => {
    const view = viewRef.current
    if (!view) {
      return
    }
    view.dispatch({
      effects: [
        themeCompartment.reconfigure(buildTheme(resolvedTheme === 'dark')),
        autocompleteCompartment.reconfigure(autocompletion({
          override: [(context: CompletionContext) => createRedisCompletionResult(context, requestCompletionsRef.current)],
          activateOnTyping: true,
        })),
      ],
    })
  }, [autocompleteCompartment, resolvedTheme, themeCompartment])

  return <div ref={rootRef} className="min-h-[74px] flex-1 overflow-hidden rounded-sm border border-border/70 bg-background/50" />
})
