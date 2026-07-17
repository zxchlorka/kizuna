import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react'
import {
  autocompletion,
  closeBrackets,
  completionKeymap,
  type Completion,
  type CompletionSource,
} from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { bracketMatching, foldGutter, indentOnInput } from '@codemirror/language'
import { searchKeymap } from '@codemirror/search'
import { Compartment, EditorSelection, EditorState, type Extension } from '@codemirror/state'
import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view'
import { PostgreSQL, keywordCompletionSource, schemaCompletionSource, sql, type SQLNamespace } from '@codemirror/lang-sql'
import { basicSetup } from 'codemirror'
import { useTheme } from 'next-themes'
import { cn } from '@/lib/utils'
import { getSqlStatementAtPosition } from '@/lib/sqlStatements'
import { createSqlCompletionSource, type SqlCatalogTable } from '@/components/SqlConsole/SqlAutocomplete'
import { useAutocomplete } from '@/hooks/useAutocomplete'
import type { SqlCatalog } from '@/types/api'

export interface SqlEditorHandle {
  focus: () => void
  formatDocument: () => void
  getSelectedTextOrCurrentStatement: () => string
}

interface SqlEditorProps {
  connId: string
  value: string
  onChange: (value: string) => void
  onRun: () => void
  onExplain: () => void
  onToggleHistory: () => void
  onHistoryNavigate: (direction: 'previous' | 'next') => void
  catalogTables: SqlCatalogTable[]
  catalogSchemas: string[]
  catalog: SqlCatalog | null
  className?: string
}

function buildSqlNamespace(catalog: SqlCatalog): SQLNamespace {
  const namespace: Record<string, Record<string, Completion[]>> = {}
  for (const [schema, tables] of Object.entries(catalog.schemas ?? {})) {
    const tableNamespace: Record<string, Completion[]> = {}
    for (const [table, columns] of Object.entries(tables)) {
      tableNamespace[table] = (columns ?? []).map((column) => ({
        label: column.name,
        type: 'property',
        detail: column.type,
        boost: 2,
      }))
    }
    namespace[schema] = tableNamespace
  }
  return namespace
}

async function formatSqlDocument(view: EditorView): Promise<void> {
  const doc = view.state.doc.toString()
  if (!doc.trim()) {
    return
  }
  try {
    const { format } = await import('sql-formatter')
    const formatted = format(doc, { language: 'postgresql', keywordCase: 'upper' })
    if (formatted !== doc) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: formatted },
        selection: EditorSelection.cursor(formatted.length),
      })
    }
  } catch {
    // sql-formatter throws on unparsable input; leave the document untouched.
  }
}

function toggleLineComments(view: EditorView): boolean {
  const changes: { from: number; to: number; insert: string }[] = []
  const { ranges } = view.state.selection

  for (const range of ranges) {
    const startLine = view.state.doc.lineAt(range.from)
    const endLine = view.state.doc.lineAt(range.to)
    const lines = []
    for (let number = startLine.number; number <= endLine.number; number += 1) {
      lines.push(view.state.doc.line(number))
    }

    const allCommented = lines.every((line) => line.text.trim().startsWith('--'))
    for (const line of lines) {
      if (allCommented) {
        const markerIndex = line.text.indexOf('--')
        if (markerIndex >= 0) {
          changes.push({
            from: line.from + markerIndex,
            to: line.from + markerIndex + 2 + (line.text[markerIndex + 2] === ' ' ? 1 : 0),
            insert: '',
          })
        }
      } else {
        changes.push({
          from: line.from,
          to: line.from,
          insert: '-- ',
        })
      }
    }
  }

  if (changes.length === 0) {
    return false
  }
  view.dispatch({ changes })
  return true
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
        overflow: 'auto',
      },
      '.cm-content': {
        padding: '16px 18px',
        caretColor: dark ? '#f8fafc' : '#0f172a',
      },
      '.cm-gutters': {
        backgroundColor: dark ? 'rgba(15, 23, 42, 0.42)' : 'rgba(248, 250, 252, 0.9)',
        color: dark ? '#94a3b8' : '#64748b',
        borderRight: dark ? '1px solid rgba(71, 85, 105, 0.55)' : '1px solid rgba(203, 213, 225, 0.9)',
      },
      '.cm-activeLine': {
        backgroundColor: dark ? 'rgba(148, 163, 184, 0.1)' : 'rgba(148, 163, 184, 0.14)',
      },
      '.cm-activeLineGutter': {
        backgroundColor: dark ? 'rgba(148, 163, 184, 0.1)' : 'rgba(148, 163, 184, 0.14)',
      },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
        backgroundColor: dark ? 'rgba(234, 179, 8, 0.26)' : 'rgba(245, 158, 11, 0.22)',
      },
      '.cm-tooltip': {
        border: dark ? '1px solid rgba(71, 85, 105, 0.8)' : '1px solid rgba(203, 213, 225, 0.9)',
        backgroundColor: dark ? '#0f172a' : '#ffffff',
      },
    },
    { dark }
  )
}

export const SqlEditor = forwardRef<SqlEditorHandle, SqlEditorProps>(function SqlEditor(
  { connId, value, onChange, onRun, onExplain, onToggleHistory, onHistoryNavigate, catalogTables, catalogSchemas, catalog, className },
  ref
) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const onRunRef = useRef(onRun)
  const onExplainRef = useRef(onExplain)
  const onToggleHistoryRef = useRef(onToggleHistory)
  const onHistoryNavigateRef = useRef(onHistoryNavigate)
  const themeCompartment = useMemo(() => new Compartment(), [])
  const autocompleteCompartment = useMemo(() => new Compartment(), [])
  const { resolvedTheme } = useTheme()
  const requestCompletions = useAutocomplete(connId)
  const requestCompletionsRef = useRef(requestCompletions)
  const catalogTablesRef = useRef(catalogTables)
  const catalogSchemasRef = useRef(catalogSchemas)
  const schemaSourceRef = useRef<CompletionSource | null>(null)

  useEffect(() => {
    schemaSourceRef.current = catalog
      ? schemaCompletionSource({
          dialect: PostgreSQL,
          schema: buildSqlNamespace(catalog),
          defaultSchema: catalog.default_schema || 'public',
        })
      : null
  }, [catalog])

  useEffect(() => {
    onChangeRef.current = onChange
    onRunRef.current = onRun
    onExplainRef.current = onExplain
    onToggleHistoryRef.current = onToggleHistory
    onHistoryNavigateRef.current = onHistoryNavigate
    requestCompletionsRef.current = requestCompletions
    catalogTablesRef.current = catalogTables
    catalogSchemasRef.current = catalogSchemas
  }, [catalogSchemas, catalogTables, onChange, onExplain, onHistoryNavigate, onRun, onToggleHistory, requestCompletions])

  useImperativeHandle(ref, () => ({
    focus: () => {
      viewRef.current?.focus()
    },
    formatDocument: () => {
      const view = viewRef.current
      if (!view) {
        return
      }
      void formatSqlDocument(view)
    },
    getSelectedTextOrCurrentStatement: () => {
      const view = viewRef.current
      if (!view) {
        return ''
      }
      const selection = view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)
      if (selection.trim()) {
        return selection.trim()
      }
      return getSqlStatementAtPosition(view.state.doc.toString(), view.state.selection.main.head)
    },
  }))

  useEffect(() => {
    if (!rootRef.current || viewRef.current) {
      return
    }

    const completionSource = createSqlCompletionSource(
      (args, signal) => requestCompletionsRef.current(args, signal),
      () => catalogTablesRef.current,
      () => catalogSchemasRef.current,
      () => schemaSourceRef.current !== null
    )
    const keywordSource = keywordCompletionSource(PostgreSQL, true)
    const schemaSource: CompletionSource = (completionContext) =>
      schemaSourceRef.current ? schemaSourceRef.current(completionContext) : null
    const keyBindings = keymap.of([
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
      ...completionKeymap,
      {
        key: 'Mod-Enter',
        run: () => {
          onRunRef.current()
          return true
        },
      },
      {
        key: 'Mod-Shift-Enter',
        run: () => {
          onExplainRef.current()
          return true
        },
      },
      {
        key: 'Mod-h',
        run: () => {
          onToggleHistoryRef.current()
          return true
        },
      },
      {
        key: 'Mod-ArrowUp',
        run: () => {
          onHistoryNavigateRef.current('previous')
          return true
        },
      },
      {
        key: 'Mod-ArrowDown',
        run: () => {
          onHistoryNavigateRef.current('next')
          return true
        },
      },
      {
        key: 'Mod-/',
        run: (view) => toggleLineComments(view),
      },
      {
        key: 'Mod-Shift-f',
        run: () => {
          const view = viewRef.current
          if (!view) {
            return false
          }
          void formatSqlDocument(view)
          return true
        },
      },
    ])

    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        history(),
        lineNumbers(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        highlightActiveLine(),
        foldGutter(),
        sql({
          dialect: PostgreSQL,
          upperCaseKeywords: true,
        }),
        keyBindings,
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString())
          }
        }),
        themeCompartment.of(buildTheme(resolvedTheme === 'dark')),
        autocompleteCompartment.of(
          autocompletion({
            override: [schemaSource, completionSource, keywordSource],
            activateOnTyping: true,
          })
        ),
      ],
    })

    viewRef.current = new EditorView({
      state,
      parent: rootRef.current,
    })

    return () => {
      viewRef.current?.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only: value/theme are applied via the sync effects below
  }, [
    autocompleteCompartment,
    themeCompartment,
  ])

  useEffect(() => {
    const view = viewRef.current
    if (!view) {
      return
    }
    view.dispatch({
      effects: themeCompartment.reconfigure(buildTheme(resolvedTheme === 'dark')),
    })
  }, [resolvedTheme, themeCompartment])

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
      changes: { from: 0, to: view.state.doc.length, insert: value },
      // Clamp the cursor to the new document: reusing the previous selection
      // as-is throws RangeError when the inserted value is shorter, which
      // unmounts the whole React tree.
      selection: EditorSelection.cursor(Math.min(view.state.selection.main.head, value.length)),
    })
  }, [value])

  return (
    <div className={cn('h-full min-h-[180px] bg-background', className)}>
      <div ref={rootRef} className="h-full" />
    </div>
  )
})
