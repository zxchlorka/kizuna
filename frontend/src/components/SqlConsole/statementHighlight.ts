import { StateField, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { getSqlStatementRanges, type SqlStatementRange } from '@/lib/sqlStatements'

interface StatementHighlightState {
  ranges: SqlStatementRange[]
  deco: DecorationSet
}

const firstLine = Decoration.line({ class: 'cm-activeStatement cm-activeStatement-first' })
const middleLine = Decoration.line({ class: 'cm-activeStatement' })
const lastLine = Decoration.line({ class: 'cm-activeStatement cm-activeStatement-last' })
const onlyLine = Decoration.line({ class: 'cm-activeStatement cm-activeStatement-first cm-activeStatement-last' })

// Mirrors getSqlStatementAtPosition so the frame always wraps exactly what
// Cmd+Enter would execute: the range containing the cursor, else the last one.
function activeRange(ranges: SqlStatementRange[], cursor: number): SqlStatementRange | null {
  if (ranges.length < 2) {
    return null
  }
  return ranges.find((range) => cursor >= range.from && cursor <= range.to) ?? ranges[ranges.length - 1]
}

function buildDeco(state: EditorState, ranges: SqlStatementRange[]): DecorationSet {
  const selection = state.selection.main
  if (!selection.empty) {
    return Decoration.none
  }

  const range = activeRange(ranges, selection.head)
  if (!range) {
    return Decoration.none
  }

  // Ranges include the whitespace that separates statements; trim it so the
  // frame hugs the statement text.
  const text = state.doc.sliceString(range.from, range.to)
  const from = range.from + (text.length - text.trimStart().length)
  const to = range.to - (text.length - text.trimEnd().length)
  if (from >= to) {
    return Decoration.none
  }

  const start = state.doc.lineAt(from).number
  const end = state.doc.lineAt(to).number
  const decorations = []
  for (let line = start; line <= end; line += 1) {
    const pos = state.doc.line(line).from
    if (start === end) {
      decorations.push(onlyLine.range(pos))
    } else if (line === start) {
      decorations.push(firstLine.range(pos))
    } else if (line === end) {
      decorations.push(lastLine.range(pos))
    } else {
      decorations.push(middleLine.range(pos))
    }
  }
  return Decoration.set(decorations)
}

const statementHighlightField = StateField.define<StatementHighlightState>({
  create(state) {
    const ranges = getSqlStatementRanges(state.doc.toString())
    return { ranges, deco: buildDeco(state, ranges) }
  },
  update(value, tr) {
    if (!tr.docChanged && !tr.selection) {
      return value
    }
    const ranges = tr.docChanged ? getSqlStatementRanges(tr.newDoc.toString()) : value.ranges
    return { ranges, deco: buildDeco(tr.state, ranges) }
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.deco),
})

export function statementHighlight(): Extension {
  return statementHighlightField
}
