import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import { autocompletion, completionKeymap, completionStatus, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, insertNewline } from '@codemirror/commands'
import { Compartment, EditorSelection, EditorState, Prec, type Extension } from '@codemirror/state'
import { EditorView, drawSelection, highlightActiveLine, keymap, tooltips } from '@codemirror/view'
import { basicSetup } from 'codemirror'
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
  // All colors reference the app's theme tokens so the console stays cohesive
  // with the rest of the interface (near-black surface, amber accent).
  return EditorView.theme(
    {
      '&': {
        height: '100%',
        fontSize: '13px',
        backgroundColor: 'transparent',
        color: 'hsl(var(--foreground))',
      },
      '.cm-scroller': {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        lineHeight: '1.6',
      },
      '.cm-content': {
        padding: '8px 4px',
        caretColor: 'hsl(var(--accent))',
      },
      '.cm-cursor, .cm-dropCursor': {
        borderLeftColor: 'hsl(var(--accent))',
        borderLeftWidth: '2px',
      },
      '.cm-line': {
        paddingLeft: '2px',
      },
      // A command prompt reads cleaner without a line-number / fold gutter.
      '.cm-gutters': {
        display: 'none',
      },
      '&.cm-focused': {
        outline: 'none',
      },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
        backgroundColor: 'hsl(var(--accent) / 0.22)',
      },
      '.cm-activeLine': {
        backgroundColor: 'transparent',
      },
      // The popup is parented to <body>, outside the .dark console, so it uses
      // the console's fixed dark palette explicitly (near-black + amber) rather
      // than inherited theme tokens.
      '.cm-tooltip': {
        border: '1px solid hsl(216 18% 20%)',
        backgroundColor: 'hsl(216 24% 10%)',
        color: 'hsl(210 20% 90%)',
        borderRadius: '8px',
        overflow: 'hidden',
        boxShadow: '0 18px 48px -16px rgba(0, 0, 0, 0.7)',
      },
      '.cm-tooltip.cm-completionInfo': {
        padding: '8px 10px',
        maxWidth: '24rem',
      },
      '.cm-tooltip-autocomplete > ul': {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        fontSize: '12px',
        maxHeight: '18rem',
      },
      '.cm-tooltip-autocomplete > ul > li': {
        padding: '5px 12px',
        color: 'hsl(210 20% 82%)',
        lineHeight: '1.5',
      },
      '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
        backgroundColor: 'hsl(38 92% 50% / 0.16)',
        color: 'hsl(210 20% 96%)',
      },
      '.cm-completionLabel': {
        fontWeight: '600',
        color: 'hsl(38 92% 62%)',
      },
      '.cm-completionDetail': {
        marginLeft: '0.75rem',
        color: 'hsl(215 15% 55%)',
        fontStyle: 'normal',
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

  // The editor must be created exactly once per mount: recreating it on value/theme
  // changes destroys focus and the completion popup mid-typing. Value sync and theme
  // changes are handled by the dedicated effects below.
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
      // Prec.highest beats basicSetup's defaultKeymap, where plain Enter is
      // bound to insertNewline. While the completion popup is open, Enter and
      // the arrows fall through to the completion keymap instead.
      Prec.highest(
        keymap.of([
          {
            key: 'Enter',
            run: (view) => {
              if (completionStatus(view.state) === 'active') {
                return false
              }
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
              if (completionStatus(view.state) === 'active') {
                return false
              }
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
              if (completionStatus(view.state) === 'active') {
                return false
              }
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
        ])
      ),
      keymap.of([...defaultKeymap, ...historyKeymap, ...completionKeymap]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          onChangeRef.current(update.state.doc.toString())
        }
      }),
      // Render the completion popup in a fixed layer on <body> so it is never
      // clipped by the input's overflow-hidden container (which previously cut
      // the list down to a single visible row).
      tooltips({ position: 'fixed', parent: document.body }),
      themeCompartment.of(buildTheme(true)),
      autocompleteCompartment.of(autocompletion({ override: [completionSource], activateOnTyping: true, maxRenderedOptions: 50 })),
    ]

    const state = EditorState.create({ doc: value, extensions })
    const view = new EditorView({ state, parent: rootRef.current })
    viewRef.current = view
    view.focus()

    return () => {
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only: value/theme are applied via the sync effects below
  }, [])

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
        themeCompartment.reconfigure(buildTheme(true)),
        autocompleteCompartment.reconfigure(autocompletion({
          override: [(context: CompletionContext) => createRedisCompletionResult(context, requestCompletionsRef.current)],
          activateOnTyping: true,
          maxRenderedOptions: 50,
        })),
      ],
    })
  }, [autocompleteCompartment, themeCompartment])

  return <div ref={rootRef} className="min-h-[40px] flex-1 overflow-hidden bg-transparent" />
})
