import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SortingState } from '@tanstack/react-table'
import { AlertCircle, Trash2, X } from 'lucide-react'
import { DataTable, type ColumnFilterState } from '@/components/DataTable'
import { PaginationBar } from '@/components/PgTableView/PaginationBar'
import { Toolbar } from '@/components/PgTableView/Toolbar'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { useDataStore } from '@/stores/data'
import type { BulkMutateOp, ColumnMeta, FilterExpr, MutateOp } from '@/types/api'

interface PgTableViewProps {
  connId: string
  object: string
  tabId: string
}

const INTEGER_TYPES = new Set(['int2', 'int4', 'int8', 'integer', 'bigint'])
const NUMERIC_TYPES = new Set(['numeric', 'float4', 'float8', 'decimal'])
const BOOL_TYPES = new Set(['bool', 'boolean'])
const JSON_TYPES = new Set(['json', 'jsonb'])
const UUID_TYPES = new Set(['uuid'])
const TEXT_TYPES = new Set(['text', 'varchar', 'bpchar', 'char'])
const TIMESTAMP_TYPES = new Set(['timestamp', 'timestamptz', 'date', 'time', 'timetz'])
const FILTER_DEBOUNCE_MS = 300
const BOOL_DEFAULT_SENTINEL = '__default__'
const VALUELESS_FILTER_OPS = new Set<FilterExpr['op']>(['is_null', 'is_not_null'])

function normalizeFilters(filters: FilterExpr[]): FilterExpr[] {
  return [...filters]
    .map((f) => ({
      column: f.column,
      op: f.op,
      value: VALUELESS_FILTER_OPS.has(f.op) ? '' : f.value.trim(),
    }))
    .filter((f) => VALUELESS_FILTER_OPS.has(f.op) || f.value !== '')
    .sort((a, b) => {
      if (a.column !== b.column) return a.column.localeCompare(b.column)
      if (a.op !== b.op) return a.op.localeCompare(b.op)
      return a.value.localeCompare(b.value)
    })
}

function filtersEqual(a: FilterExpr[], b: FilterExpr[]): boolean {
  const na = normalizeFilters(a)
  const nb = normalizeFilters(b)
  if (na.length !== nb.length) return false
  for (let i = 0; i < na.length; i++) {
    if (na[i].column !== nb[i].column || na[i].op !== nb[i].op || na[i].value !== nb[i].value) {
      return false
    }
  }
  return true
}

function defaultFilterOp(dataType: string): FilterExpr['op'] {
  const dt = dataType.toLowerCase()
  if (INTEGER_TYPES.has(dt) || NUMERIC_TYPES.has(dt) || TIMESTAMP_TYPES.has(dt) || dt === 'uuid' || BOOL_TYPES.has(dt)) {
    return 'eq'
  }
  return 'contains'
}

function filtersToState(columns: ColumnMeta[], filters: FilterExpr[]): Record<string, ColumnFilterState> {
  const out: Record<string, ColumnFilterState> = {}
  columns.forEach((col) => {
    out[col.name] = { op: defaultFilterOp(col.data_type), value: '' }
  })
  filters.forEach((f) => {
    out[f.column] = {
      op: f.op,
      value: VALUELESS_FILTER_OPS.has(f.op) ? '' : f.value,
    }
  })
  return out
}

function hasUUIDDefault(col: ColumnMeta): boolean {
  if (!col.default) return false
  const lower = col.default.toLowerCase()
  return lower.includes('uuid_generate') || lower.includes('gen_random_uuid')
}

function parseFormValue(raw: string, col: ColumnMeta): { include: boolean; value?: any; error?: string } {
  if (raw === BOOL_DEFAULT_SENTINEL) {
    if (!col.nullable && !col.default) {
      return { include: false, error: 'Required field' }
    }
    return { include: false }
  }

  const dt = col.data_type.toLowerCase()
  const trimmed = raw.trim()
  const nullable = col.nullable

  if (trimmed === '') {
    if (UUID_TYPES.has(dt) && hasUUIDDefault(col)) {
      return { include: false }
    }
    if (col.default) {
      return { include: false }
    }
    if (TEXT_TYPES.has(dt)) {
      return { include: true, value: '' }
    }
    if (nullable) {
      return { include: true, value: null }
    }
    return { include: false, error: 'Required field' }
  }

  if (BOOL_TYPES.has(dt)) {
    if (trimmed !== 'true' && trimmed !== 'false' && trimmed !== 'null') {
      return { include: false, error: 'Use true/false/null' }
    }
    if (trimmed === 'null') {
      if (!nullable) return { include: false, error: 'Column is not nullable' }
      return { include: true, value: null }
    }
    return { include: true, value: trimmed === 'true' }
  }

  if (INTEGER_TYPES.has(dt)) {
    const n = Number(trimmed)
    if (!Number.isInteger(n)) return { include: false, error: 'Integer expected' }
    return { include: true, value: n }
  }

  if (NUMERIC_TYPES.has(dt)) {
    const n = Number(trimmed)
    if (Number.isNaN(n)) return { include: false, error: 'Numeric value expected' }
    return { include: true, value: n }
  }

  if (UUID_TYPES.has(dt)) {
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    if (!uuidRe.test(trimmed)) return { include: false, error: 'Invalid UUID' }
    return { include: true, value: trimmed }
  }

  if (JSON_TYPES.has(dt)) {
    try {
      return { include: true, value: JSON.parse(raw) }
    } catch {
      return { include: false, error: 'Invalid JSON' }
    }
  }

  return { include: true, value: raw }
}

function buildPkWhere(columns: ColumnMeta[], row: any[]): { where: Record<string, any>; ok: boolean } {
  const pkCols = columns.filter((c) => c.is_pk)
  if (pkCols.length === 0) {
    return { where: {}, ok: false }
  }

  const where: Record<string, any> = {}
  for (const col of pkCols) {
    const idx = columns.findIndex((c) => c.name === col.name)
    if (idx < 0) {
      return { where: {}, ok: false }
    }
    const value = row[idx]
    if (value === null || value === undefined) {
      return { where: {}, ok: false }
    }
    where[col.name] = value
  }

  return { where, ok: true }
}

function stableWhereKey(where: Record<string, any>): string {
  const keys = Object.keys(where).sort()
  return keys.map((k) => `${k}=${JSON.stringify(where[k])}`).join('|')
}

export function PgTableView({ connId, object, tabId }: PgTableViewProps) {
  const tabData = useDataStore((state) => state.tabs[tabId])
  const fetchSchema = useDataStore((state) => state.fetchSchema)
  const fetchData = useDataStore((state) => state.fetchData)
  const mutate = useDataStore((state) => state.mutate)
  const mutateBulk = useDataStore((state) => state.mutateBulk)
  const setOpts = useDataStore((state) => state.setOpts)
  const setDraftCell = useDataStore((state) => state.setDraftCell)
  const toggleDraftDelete = useDataStore((state) => state.toggleDraftDelete)
  const clearDrafts = useDataStore((state) => state.clearDrafts)
  const stageInsert = useDataStore((state) => state.stageInsert)
  const removeStagedInsert = useDataStore((state) => state.removeStagedInsert)

  const [sorting, setSorting] = useState<SortingState>([])
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set())
  const [editMode, setEditMode] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [newRowData, setNewRowData] = useState<Record<string, string>>({})
  const [newRowErrors, setNewRowErrors] = useState<Record<string, string>>({})
  const [localError, setLocalError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const skipFirstFilterFetch = useRef(true)

  const [schemaName, tableName] = object.includes('.') ? object.split('.', 2) : ['public', object]

  useEffect(() => {
    fetchSchema(connId, object, tabId).then(() => fetchData(connId, object, tabId))
    setSelectedRows(new Set())
    setSorting([])
    setEditMode(false)
    clearDrafts(tabId)
    skipFirstFilterFetch.current = true
  }, [connId, object, tabId, clearDrafts, fetchData, fetchSchema])

  const columns = tabData?.columns ?? []
  const rows = tabData?.rows ?? []
  const opts = tabData?.opts
  const isLoading = tabData?.loading ?? false
  const error = tabData?.error ?? null

  const draftUpdates = tabData?.draftUpdates ?? {}
  const draftDeletes = tabData?.draftDeletes ?? {}
  const draftInserts = tabData?.draftInserts ?? []
  const activeFilters = opts?.filters ?? []
  const pkColumns = useMemo(() => columns.filter((c) => c.is_pk), [columns])
  const hasPrimaryKey = pkColumns.length > 0
  const rowIdentityByIndex = useMemo(
    () =>
      rows.map((row) => {
        const built = buildPkWhere(columns, row)
        if (!built.ok) return null
        return { where: built.where, rowKey: stableWhereKey(built.where) }
      }),
    [columns, rows]
  )
  const deletedRowIndexes = useMemo(() => {
    const out = new Set<number>()
    rowIdentityByIndex.forEach((identity, idx) => {
      if (!identity) return
      if (draftDeletes[identity.rowKey]) {
        out.add(idx)
      }
    })
    return out
  }, [draftDeletes, rowIdentityByIndex])

  const filterState = useMemo(() => filtersToState(columns, activeFilters), [activeFilters, columns])
  const filterSignature = useMemo(() => JSON.stringify(normalizeFilters(activeFilters)), [activeFilters])

  const pendingCount = useMemo(() => {
    const cells = Object.values(draftUpdates).reduce((sum, rowDraft) => sum + Object.keys(rowDraft.data).length, 0)
    return cells + Object.keys(draftDeletes).length + draftInserts.length
  }, [draftUpdates, draftDeletes, draftInserts])

  const refresh = useCallback(() => {
    fetchData(connId, object, tabId)
  }, [connId, object, tabId, fetchData])

  const handleSortChange = useCallback(
    (col: string, dir: 'asc' | 'desc' | null) => {
      if (dir === null) {
        setSorting([])
        setOpts(tabId, { order_by: '', order_dir: 'asc', offset: 0 })
      } else {
        setSorting([{ id: col, desc: dir === 'desc' }])
        setOpts(tabId, { order_by: col, order_dir: dir, offset: 0 })
      }
      fetchData(connId, object, tabId)
    },
    [connId, object, tabId, fetchData, setOpts]
  )

  const currentOffset = opts?.offset ?? 0
  const currentLimit = opts?.limit ?? 50
  const total = tabData?.total ?? 0

  const handleNext = useCallback(() => {
    setOpts(tabId, { offset: currentOffset + currentLimit })
    fetchData(connId, object, tabId)
  }, [connId, currentLimit, currentOffset, fetchData, object, setOpts, tabId])

  const handlePrev = useCallback(() => {
    setOpts(tabId, { offset: Math.max(0, currentOffset - currentLimit) })
    fetchData(connId, object, tabId)
  }, [connId, currentLimit, currentOffset, fetchData, object, setOpts, tabId])

  const handlePageSizeChange = useCallback(
    (n: number) => {
      setOpts(tabId, { limit: n, offset: 0 })
      fetchData(connId, object, tabId)
    },
    [connId, object, tabId, setOpts, fetchData]
  )

  const handleFilterChange = useCallback(
    (filters: FilterExpr[]) => {
      if (filtersEqual(filters, activeFilters)) {
        return
      }
      setOpts(tabId, { filters, offset: 0 })
    },
    [activeFilters, setOpts, tabId]
  )

  const handleFilterStateChange = useCallback(
    (column: string, next: ColumnFilterState) => {
      const nextState: Record<string, ColumnFilterState> = { ...filterState, [column]: next }
      const nextFilters: FilterExpr[] = Object.entries(nextState).flatMap(([col, state]) => {
        if (VALUELESS_FILTER_OPS.has(state.op)) {
          return [{ column: col, op: state.op, value: '' }]
        }
        const trimmed = state.value.trim()
        if (trimmed === '') return []
        return [{ column: col, op: state.op, value: trimmed }]
      })
      handleFilterChange(nextFilters)
    },
    [filterState, handleFilterChange]
  )

  useEffect(() => {
    if (skipFirstFilterFetch.current) {
      skipFirstFilterFetch.current = false
      return
    }

    const timeout = setTimeout(() => {
      fetchData(connId, object, tabId)
    }, FILTER_DEBOUNCE_MS)

    return () => clearTimeout(timeout)
  }, [connId, fetchData, filterSignature, object, tabId])

  const getDraftValue = useCallback(
    (rowIndex: number, colName: string, fallback: any) => {
      const identity = rowIdentityByIndex[rowIndex]
      if (!identity) return fallback
      const rowDraft = draftUpdates[identity.rowKey]
      if (!rowDraft) return fallback
      if (!(colName in rowDraft.data)) return fallback
      return rowDraft.data[colName]
    },
    [draftUpdates, rowIdentityByIndex]
  )

  const isDirtyCell = useCallback(
    (rowIndex: number, colName: string) => {
      const identity = rowIdentityByIndex[rowIndex]
      if (!identity) return false
      return Boolean(draftUpdates[identity.rowKey] && colName in draftUpdates[identity.rowKey].data)
    },
    [draftUpdates, rowIdentityByIndex]
  )

  const handleCellChange = useCallback(
    (rowIndex: number, colName: string, value: any) => {
      if (!editMode || !hasPrimaryKey) return
      const identity = rowIdentityByIndex[rowIndex]
      if (!identity) {
        setLocalError('Cannot edit this row: primary key value is missing.')
        return
      }
      setDraftCell(tabId, identity.rowKey, identity.where, colName, value)
    },
    [editMode, hasPrimaryKey, rowIdentityByIndex, setDraftCell, tabId]
  )

  const handleToggleRow = useCallback((rowIndex: number, checked: boolean) => {
    setSelectedRows((prev) => {
      const next = new Set(prev)
      if (checked) next.add(rowIndex)
      else next.delete(rowIndex)
      return next
    })
  }, [])

  const handleToggleAll = useCallback(
    (checked: boolean) => {
      if (checked) {
        setSelectedRows(new Set(rows.map((_, index) => index)))
      } else {
        setSelectedRows(new Set())
      }
    },
    [rows]
  )

  const handleDeleteSelected = useCallback(() => {
    if (selectedRows.size === 0) return
    if (!hasPrimaryKey) {
      setLocalError('Delete is disabled for tables without primary key.')
      return
    }
    if (editMode) {
      selectedRows.forEach((rowIndex) => {
        const identity = rowIdentityByIndex[rowIndex]
        if (!identity) return
        toggleDraftDelete(tabId, identity.rowKey, identity.where, true)
      })
      setSelectedRows(new Set())
      return
    }
    setShowDeleteDialog(true)
  }, [selectedRows, hasPrimaryKey, editMode, rowIdentityByIndex, toggleDraftDelete, tabId])

  const confirmImmediateDelete = useCallback(async () => {
    if (!hasPrimaryKey) {
      setLocalError('Delete is disabled for tables without primary key.')
      return
    }
    setIsSaving(true)
    setLocalError(null)
    try {
      for (const rowIndex of Array.from(selectedRows)) {
        const identity = rowIdentityByIndex[rowIndex]
        if (!identity) continue
        await mutate(
          connId,
          {
            type: 'delete',
            schema: schemaName,
            object: tableName,
            where: identity.where,
          },
          tabId
        )
      }
      setSelectedRows(new Set())
      setShowDeleteDialog(false)
      await fetchData(connId, object, tabId)
    } catch (e) {
      setLocalError((e as Error).message)
    } finally {
      setIsSaving(false)
    }
  }, [hasPrimaryKey, connId, fetchData, mutate, object, rowIdentityByIndex, schemaName, selectedRows, tabId, tableName])

  const handleToggleEditMode = () => {
    if (editMode && pendingCount > 0) {
      setLocalError('You have pending draft changes. Save all or Cancel all first.')
      return
    }
    setEditMode((v) => !v)
    setLocalError(null)
  }

  const handleCancelAll = () => {
    clearDrafts(tabId)
    setSelectedRows(new Set())
    setEditMode(false)
    setLocalError(null)
  }

  const buildBulkOperations = useCallback((): MutateOp[] => {
    const ops: MutateOp[] = []

    Object.entries(draftUpdates).forEach(([rowKey, draft]) => {
      if (draftDeletes[rowKey]) return
      if (Object.keys(draft.data).length === 0) return

      ops.push({
        type: 'update',
        schema: schemaName,
        object: tableName,
        where: draft.where,
        data: draft.data,
      })
    })

    Object.values(draftDeletes).forEach((draft) => {
      ops.push({
        type: 'delete',
        schema: schemaName,
        object: tableName,
        where: draft.where,
      })
    })

    draftInserts.forEach((data) => {
      ops.push({
        type: 'insert',
        schema: schemaName,
        object: tableName,
        data,
      })
    })

    return ops
  }, [draftDeletes, draftInserts, draftUpdates, schemaName, tableName])

  const handleSaveAll = async () => {
    const operations = buildBulkOperations()
    if (operations.length === 0) {
      setShowSaveDialog(false)
      return
    }

    setIsSaving(true)
    setLocalError(null)
    try {
      const payload: BulkMutateOp = {
        schema: schemaName,
        object: tableName,
        operations,
      }
      await mutateBulk(connId, payload, tabId)
      clearDrafts(tabId)
      setSelectedRows(new Set())
      setEditMode(false)
      setShowSaveDialog(false)
      await fetchData(connId, object, tabId)
    } catch (e) {
      setLocalError((e as Error).message)
    } finally {
      setIsSaving(false)
    }
  }

  const openAddRowDialog = () => {
    const initial: Record<string, string> = {}
    columns.forEach((col) => {
      const dt = col.data_type.toLowerCase()
      initial[col.name] = BOOL_TYPES.has(dt) ? BOOL_DEFAULT_SENTINEL : ''
    })
    setNewRowData(initial)
    setNewRowErrors({})
    setShowAddDialog(true)
  }

  const saveAddRow = async () => {
    const validationErrors: Record<string, string> = {}
    const data: Record<string, any> = {}

    columns.forEach((col) => {
      const parsed = parseFormValue(newRowData[col.name] ?? '', col)
      if (parsed.error) {
        validationErrors[col.name] = parsed.error
        return
      }
      if (parsed.include) {
        data[col.name] = parsed.value
      }
    })

    if (Object.keys(validationErrors).length > 0) {
      setNewRowErrors(validationErrors)
      return
    }

    if (editMode) {
      stageInsert(tabId, data)
      setShowAddDialog(false)
      return
    }

    setIsSaving(true)
    setLocalError(null)
    try {
      await mutate(
        connId,
        {
          type: 'insert',
          schema: schemaName,
          object: tableName,
          data,
        },
        tabId
      )
      setShowAddDialog(false)
      await fetchData(connId, object, tabId)
    } catch (e) {
      setLocalError((e as Error).message)
    } finally {
      setIsSaving(false)
    }
  }

  const isInitialLoad = isLoading && rows.length === 0 && !error

  if (error && rows.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
        <AlertCircle className="h-10 w-10 text-destructive opacity-70" />
        <div>
          <p className="text-sm font-medium text-foreground">Failed to load data</p>
          <p className="mt-1 text-xs text-muted-foreground">{error}</p>
        </div>
        <Button size="sm" variant="outline" onClick={refresh}>
          Retry
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <Toolbar
        onRefresh={refresh}
        onAddRow={openAddRowDialog}
        onDeleteSelected={handleDeleteSelected}
        canDeleteRows={hasPrimaryKey}
        selectedCount={selectedRows.size}
        pageSize={currentLimit}
        onPageSizeChange={handlePageSizeChange}
        loading={isLoading || isSaving}
        editMode={editMode}
        pendingCount={pendingCount}
        onToggleEditMode={handleToggleEditMode}
        onSaveAll={() => setShowSaveDialog(true)}
        onCancelAll={handleCancelAll}
      />

      {localError && (
        <div className="mx-2 mt-2 flex items-center justify-between rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <span>{localError}</span>
          <button onClick={() => setLocalError(null)} className="rounded p-1 hover:bg-destructive/20">
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      <div className="relative flex flex-1 flex-col overflow-hidden p-1">
        {isInitialLoad ? (
          <div className="flex-1 overflow-auto p-2">
            <div className="space-y-1">
              <div className="flex gap-1">
                {[...Array(6)].map((_, i) => (
                  <Skeleton key={i} className="h-9 flex-1" />
                ))}
              </div>
              {[...Array(10)].map((_, i) => (
                <div key={i} className="flex gap-1">
                  {[...Array(6)].map((_, j) => (
                    <Skeleton key={j} className="h-8 flex-1" />
                  ))}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            loading={isLoading || isSaving}
            sorting={sorting}
            filterState={filterState}
            selectedRows={selectedRows}
            editMode={editMode && hasPrimaryKey}
            draftDeletes={deletedRowIndexes}
            onSortChange={handleSortChange}
            onFilterChange={handleFilterStateChange}
            onToggleRow={handleToggleRow}
            onToggleAll={handleToggleAll}
            onCellChange={handleCellChange}
            getDraftValue={getDraftValue}
            isDirtyCell={isDirtyCell}
          />
        )}
      </div>

      {draftInserts.length > 0 && (
        <div className="mx-2 mb-2 rounded border border-border bg-muted/20 p-2">
          <div className="mb-1 text-xs font-medium text-foreground">Staged inserts: {draftInserts.length}</div>
          <div className="space-y-1">
            {draftInserts.map((rowDraft, idx) => (
              <div key={idx} className="flex items-center justify-between rounded border border-border bg-background px-2 py-1">
                <span className="truncate text-xs text-muted-foreground">
                  {Object.entries(rowDraft)
                    .slice(0, 3)
                    .map(([k, v]) => `${k}=${String(v)}`)
                    .join(', ')}
                </span>
                <button
                  type="button"
                  className="ml-2 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => removeStagedInsert(tabId, idx)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <PaginationBar offset={currentOffset} limit={currentLimit} total={total} onPrev={handlePrev} onNext={handleNext} />

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete selected rows?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. {selectedRows.size} {selectedRows.size === 1 ? 'row' : 'rows'} will be deleted from
              {' '}<span className="font-mono">{object}</span>.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSaving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmImmediateDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={isSaving}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showSaveDialog} onOpenChange={setShowSaveDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apply pending changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Changes will be written to the database in a single bulk transaction.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSaving}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleSaveAll} disabled={isSaving}>
              Apply changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {showAddDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="flex max-h-[85vh] w-full max-w-5xl flex-col rounded-lg border border-border bg-background shadow-2xl">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Add row to {object}</h3>
                <p className="text-xs text-muted-foreground">Fill only required fields. Empty optional fields use DB defaults/NULL.</p>
              </div>
              <button
                type="button"
                onClick={() => setShowAddDialog(false)}
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="grid max-h-[65vh] grid-cols-1 gap-3 overflow-auto p-4 md:grid-cols-2 xl:grid-cols-3">
              {columns.map((col) => {
                const dt = col.data_type.toLowerCase()
                const isBool = BOOL_TYPES.has(dt)
                const isJson = JSON_TYPES.has(dt)
                const helper = UUID_TYPES.has(dt) && hasUUIDDefault(col) ? 'leave empty for DB-generated UUID' : null

                return (
                  <div key={col.name} className="space-y-1">
                    <label className="block text-xs font-medium text-foreground">
                      {col.name}
                      <span className="ml-1 text-[10px] text-muted-foreground">({col.data_type})</span>
                    </label>

                    {isBool ? (
                      <Select
                        value={newRowData[col.name] ?? BOOL_DEFAULT_SENTINEL}
                        onValueChange={(value) => {
                          setNewRowData((prev) => ({ ...prev, [col.name]: value }))
                          setNewRowErrors((prev) => ({ ...prev, [col.name]: '' }))
                        }}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue placeholder={col.nullable ? 'default / null' : 'select'} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={BOOL_DEFAULT_SENTINEL}>default</SelectItem>
                          <SelectItem value="true">true</SelectItem>
                          <SelectItem value="false">false</SelectItem>
                          {col.nullable && <SelectItem value="null">null</SelectItem>}
                        </SelectContent>
                      </Select>
                    ) : isJson ? (
                      <textarea
                        value={newRowData[col.name] ?? ''}
                        onChange={(e) => {
                          setNewRowData((prev) => ({ ...prev, [col.name]: e.target.value }))
                          setNewRowErrors((prev) => ({ ...prev, [col.name]: '' }))
                        }}
                        placeholder={helper ?? (col.nullable ? 'empty => null/default' : '')}
                        rows={4}
                        className="w-full resize-y rounded border border-border bg-background px-2 py-1.5 text-xs font-mono outline-none ring-ring/20 focus:ring-2"
                      />
                    ) : (
                      <input
                        value={newRowData[col.name] ?? ''}
                        onChange={(e) => {
                          setNewRowData((prev) => ({ ...prev, [col.name]: e.target.value }))
                          setNewRowErrors((prev) => ({ ...prev, [col.name]: '' }))
                        }}
                        placeholder={helper ?? (col.nullable ? 'empty => null/default' : '')}
                        className="h-8 w-full rounded border border-border bg-background px-2 text-xs outline-none ring-ring/20 focus:ring-2"
                      />
                    )}

                    {helper && <p className="text-[10px] text-muted-foreground">{helper}</p>}
                    {newRowErrors[col.name] && <p className="text-[10px] text-destructive">{newRowErrors[col.name]}</p>}
                  </div>
                )
              })}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
              <Button variant="outline" size="sm" onClick={() => setShowAddDialog(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={saveAddRow} disabled={isSaving}>
                {editMode ? 'Stage row' : 'Insert row'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
