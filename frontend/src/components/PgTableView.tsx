import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SortingState } from '@tanstack/react-table'
import { Trash2, X } from 'lucide-react'
import { AddColumnForm } from '@/components/DDL/AddColumnForm'
import { CreateIndexForm } from '@/components/DDL/CreateIndexForm'
import { DropConfirmDialog } from '@/components/DDL/DropConfirmDialog'
import { DataTable } from '@/components/DataTable'
import { ReferencedByDialog } from '@/components/DataTable/ReferencedByDialog'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { FkBreadcrumb } from '@/components/Navigation/FkBreadcrumb'
import { CreateLinkDialog } from '@/components/links/CreateLinkDialog'
import { AddRowDialog } from '@/components/PgTableView/AddRowDialog'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { PaginationBar } from '@/components/PgTableView/PaginationBar'
import { Toolbar } from '@/components/PgTableView/Toolbar'
import { Button } from '@/components/ui/button'
import { FloatingMenu, FloatingMenuItem, FloatingMenuLabel, FloatingMenuSeparator } from '@/components/ui/floating-menu'
import { useLinksStore } from '@/stores/links'
import { useOpenLinkSource, useOpenLinkTarget } from '@/hooks/useOpenLink'
import { canReverse, extractPgColumn, linkSourceLabel, linkTargetLabel } from '@/lib/links'
import { classifyDataLoadError } from '@/lib/data-load-errors'
import { clipboardFailureMessage, writeClipboardText } from '@/lib/clipboard'
import {
  buildCSV,
  buildJSON,
  buildTSV,
  copySingleCellText,
  downloadTextFile,
  timestampForFilename,
  type ExportColumn,
} from '@/lib/tableExport'
import { buildBulkMutatePayload, draftCellValue, type DraftDeleteState, type DraftUpdateState } from '@/lib/table-drafts'
import {
  buildRowIdentity,
  filtersEqual,
  filtersToState,
  normalizeFilters,
  resolveSelectedRows,
  VALUELESS_FILTER_OPS,
} from '@/lib/table'
import { useDataStore } from '@/stores/data'
import { useToastStore } from '@/stores/toast'
import { useWorkspaceStore } from '@/stores/workspace'
import type { ColumnMeta, FKRef, FilterExpr, LinkRecord, TableRow } from '@/types/api'
import type { RowIdentity } from '@/types/table'

interface PgTableViewProps {
  connId: string
  object: string
  tabId: string
}

const FILTER_DEBOUNCE_MS = 300
const EMPTY_COLUMNS: ColumnMeta[] = []
const EMPTY_REFERENCED_BY: FKRef[] = []
const EMPTY_ROWS: TableRow[] = []
const EMPTY_FILTERS: FilterExpr[] = []
const EMPTY_DRAFT_UPDATES: Record<string, DraftUpdateState> = {}
const EMPTY_DRAFT_DELETES: Record<string, DraftDeleteState> = {}
const EMPTY_INSERTS: Record<string, unknown>[] = []
type DDLDialog = 'drop_table' | 'add_column' | 'drop_column' | 'create_index' | null

// One checked row: how to address it in a mutation, and what it contained when
// it was checked. See the selectedRows state for why both halves are kept.
interface SelectedRow {
  where: Record<string, unknown>
  row: TableRow
}

function parseObjectName(object: string): { schema: string; table: string } {
  const [schema, table] = object.includes('.') ? object.split('.', 2) : ['public', object]
  return { schema, table }
}

function formatFilterLabel(filter: FilterExpr): string {
  const opLabels: Record<FilterExpr['op'], string> = {
    eq: '=',
    neq: '!=',
    gt: '>',
    gte: '>=',
    lt: '<',
    lte: '<=',
    like: 'LIKE',
    contains: '~',
    is_null: 'is null',
    is_not_null: 'is not null',
  }

  if (filter.op === 'is_null' || filter.op === 'is_not_null') {
    return `${filter.column} ${opLabels[filter.op]}`
  }

  return `${filter.column} ${opLabels[filter.op]} ${filter.value}`
}

export function PgTableView({ connId, object, tabId }: PgTableViewProps) {
  const tabData = useDataStore((state) => state.tabs[tabId])
  const fetchSchema = useDataStore((state) => state.fetchSchema)
  const fetchData = useDataStore((state) => state.fetchData)
  const mutate = useDataStore((state) => state.mutate)
  const mutateBulk = useDataStore((state) => state.mutateBulk)
  const ddl = useDataStore((state) => state.ddl)
  const setOpts = useDataStore((state) => state.setOpts)
  const setDraftCell = useDataStore((state) => state.setDraftCell)
  const toggleDraftDelete = useDataStore((state) => state.toggleDraftDelete)
  const clearDrafts = useDataStore((state) => state.clearDrafts)
  const stageInsert = useDataStore((state) => state.stageInsert)
  const removeStagedInsert = useDataStore((state) => state.removeStagedInsert)
  const refreshTree = useWorkspaceStore((state) => state.refreshTree)
  const tabs = useWorkspaceStore((state) => state.tabs)
  const closeTab = useWorkspaceStore((state) => state.closeTab)
  const openTabWithFilter = useWorkspaceStore((state) => state.openTabWithFilter)
  const clearObjectTabFilterState = useWorkspaceStore((state) => state.clearObjectTabFilterState)
  const goBackFromTab = useWorkspaceStore((state) => state.goBackFromTab)
  const pushToast = useToastStore((state) => state.push)
  const links = useLinksStore((state) => state.links)
  const fetchLinks = useLinksStore((state) => state.fetch)
  const openLinkTarget = useOpenLinkTarget()

  const [sorting, setSorting] = useState<SortingState>([])
  const [linkMenu, setLinkMenu] = useState<
    { x: number; y: number; row: TableRow; column?: string; value?: unknown } | null
  >(null)
  const [createLinkOpen, setCreateLinkOpen] = useState(false)
  // rowKey -> the row's PK predicate AND the row itself.
  //
  // Selection survives paging on purpose (Delete selected has always acted on
  // every selected row, wherever it was selected), and `where` alone is enough
  // to delete. Copy/export need the row's actual values, which only exist for
  // the page they were read from -- so the row is captured at selection time.
  // Deriving them later by intersecting with the current page instead is what
  // made "Copy selected (12)" put 3 rows, or none, on the clipboard.
  const [selectedRows, setSelectedRows] = useState<Map<string, SelectedRow>>(new Map())
  const [editMode, setEditMode] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [showReferencedByDialog, setShowReferencedByDialog] = useState(false)
  const [activeDDLDialog, setActiveDDLDialog] = useState<DDLDialog>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const skipFirstFilterFetch = useRef(true)

  const { schema: schemaName, table: tableName } = useMemo(() => parseObjectName(object), [object])

  useEffect(() => {
    void fetchLinks().catch(() => undefined)
  }, [fetchLinks])

  const tableLinks = useMemo(
    () =>
      links.filter(
        (link) =>
          link.source_conn_id === connId && link.source_scope === object && link.source_kind === 'postgres'
      ),
    [links, connId, object]
  )

  const openLinkSource = useOpenLinkSource()
  const reverseLinks = useMemo(
    () =>
      links.filter(
        (link) =>
          link.target_conn_id === connId &&
          link.target_kind === 'postgres' &&
          link.table === object &&
          canReverse(link)
      ),
    [links, connId, object]
  )

  useEffect(() => {
    void (async () => {
      await fetchData(connId, object, tabId)
      const current = useDataStore.getState().tabs[tabId]
      if (!current?.dataError) {
        await fetchSchema(connId, object, tabId)
      }
    })()
    setSelectedRows(new Map())
    setSorting([])
    setEditMode(false)
    setActiveDDLDialog(null)
    setLocalError(null)
    clearDrafts(tabId)
    skipFirstFilterFetch.current = true
  }, [clearDrafts, connId, fetchData, fetchSchema, object, tabId])

  const columns = tabData?.columns ?? EMPTY_COLUMNS
  const columnNames = useMemo(() => columns.map((c) => c.name), [columns])
  const referencedBy = tabData?.referencedBy ?? EMPTY_REFERENCED_BY
  const rows = tabData?.rows ?? EMPTY_ROWS
  const opts = tabData?.opts
  const isLoading = tabData?.loading ?? false
  const error = tabData?.error ?? null
  const total = tabData?.total ?? 0
  const hasMore = tabData?.hasMore ?? false
  const draftUpdates = tabData?.draftUpdates ?? EMPTY_DRAFT_UPDATES
  const draftDeletes = tabData?.draftDeletes ?? EMPTY_DRAFT_DELETES
  const draftInserts = tabData?.draftInserts ?? EMPTY_INSERTS

  const activeFilters = opts?.filters ?? EMPTY_FILTERS
  const currentOffset = opts?.offset ?? 0
  const currentLimit = opts?.limit ?? 50
  const activeTab = useMemo(
    () => tabs.find((tab): tab is Extract<(typeof tabs)[number], { kind: 'object' }> => tab.kind === 'object' && tab.id === tabId),
    [tabId, tabs]
  )
  const pkColumns = useMemo(() => columns.filter((column) => column.is_pk), [columns])
  const hasPrimaryKey = pkColumns.length > 0

  const rowIdentityEntries = useMemo(() => {
    return rows.map((row, rowIndex) => {
      const identity = buildRowIdentity(columns, row)
      const fallbackKey = `__row:${rowIndex}`
      return {
        row,
        rowIndex,
        rowKey: identity?.rowKey ?? fallbackKey,
        identity,
      }
    })
  }, [columns, rows])

  const rowKeyByRow = useMemo(() => {
    const out = new Map<TableRow, string>()
    rowIdentityEntries.forEach((entry) => {
      out.set(entry.row, entry.rowKey)
    })
    return out
  }, [rowIdentityEntries])

  // Keyed by rowKey and carrying the whole entry, not just the identity: row
  // selection needs the row's values as well as its PK predicate (see
  // selectedRows), and a second parallel map would be one more thing to keep in
  // step with this one.
  const rowEntryByKey = useMemo(() => {
    const out = new Map<string, (typeof rowIdentityEntries)[number] & { identity: RowIdentity }>()
    rowIdentityEntries.forEach((entry) => {
      if (entry.identity) {
        out.set(entry.rowKey, { ...entry, identity: entry.identity })
      }
    })
    return out
  }, [rowIdentityEntries])

  const deletedRowKeys = useMemo(() => new Set(Object.keys(draftDeletes)), [draftDeletes])
  const selectedRowKeys = useMemo(() => new Set(selectedRows.keys()), [selectedRows])
  const filterState = useMemo(() => filtersToState(columns, activeFilters), [activeFilters, columns])
  const filterSignature = useMemo(() => JSON.stringify(normalizeFilters(activeFilters)), [activeFilters])
  const filterBadgeLabel = useMemo(() => activeFilters.map(formatFilterLabel).join(' and '), [activeFilters])
  const selectedRowEntry = useMemo(() => {
    if (selectedRows.size !== 1) {
      return null
    }
    const [rowKey] = Array.from(selectedRows.keys())
    return rowIdentityEntries.find((entry) => entry.rowKey === rowKey) ?? null
  }, [rowIdentityEntries, selectedRows])
  const canOpenReferencedBy = referencedBy.length > 0 && selectedRowEntry !== null

  const pendingCount = useMemo(() => {
    const cellUpdates = Object.values(draftUpdates).reduce((sum, rowDraft) => sum + Object.keys(rowDraft.data).length, 0)
    return cellUpdates + Object.keys(draftDeletes).length + draftInserts.length
  }, [draftDeletes, draftInserts, draftUpdates])

  const getRowKey = useCallback(
    (row: TableRow, rowIndex: number) => rowKeyByRow.get(row) ?? `__row:${rowIndex}`,
    [rowKeyByRow]
  )

  const refresh = useCallback(() => {
    void fetchData(connId, object, tabId)
  }, [connId, fetchData, object, tabId])

  const handleSortChange = useCallback(
    (column: string, direction: 'asc' | 'desc' | null) => {
      const nextOpts = direction === null
        ? { order_by: '', order_dir: 'asc' as const, offset: 0 }
        : { order_by: column, order_dir: direction, offset: 0 }
      if (direction === null) {
        setSorting([])
      } else {
        setSorting([{ id: column, desc: direction === 'desc' }])
      }
      setOpts(tabId, nextOpts)
      void fetchData(connId, object, tabId, nextOpts)
    },
    [connId, fetchData, object, setOpts, tabId]
  )

  const handleNext = useCallback(() => {
    const nextOpts = { offset: currentOffset + currentLimit }
    setOpts(tabId, nextOpts)
    void fetchData(connId, object, tabId, nextOpts)
  }, [connId, currentLimit, currentOffset, fetchData, object, setOpts, tabId])

  const handlePrev = useCallback(() => {
    const nextOpts = { offset: Math.max(0, currentOffset - currentLimit) }
    setOpts(tabId, nextOpts)
    void fetchData(connId, object, tabId, nextOpts)
  }, [connId, currentLimit, currentOffset, fetchData, object, setOpts, tabId])

  const handlePageSizeChange = useCallback(
    (limit: number) => {
      const nextOpts = { limit, offset: 0 }
      setOpts(tabId, nextOpts)
      void fetchData(connId, object, tabId, nextOpts)
    },
    [connId, fetchData, object, setOpts, tabId]
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
    (column: string, nextState: { op: FilterExpr['op']; value: string }) => {
      const mergedState = { ...filterState, [column]: nextState }
      const nextFilters: FilterExpr[] = Object.entries(mergedState).flatMap(([columnName, state]) => {
        if (VALUELESS_FILTER_OPS.has(state.op)) {
          return [{ column: columnName, op: state.op, value: '' }]
        }
        const trimmed = state.value.trim()
        if (trimmed === '') return []
        return [{ column: columnName, op: state.op, value: trimmed }]
      })
      handleFilterChange(nextFilters)
    },
    [filterState, handleFilterChange]
  )

  const handleNavigateToFk = useCallback(
    (column: ColumnMeta, value: unknown) => {
      if (value === null || value === undefined || !column.fk_column || !column.fk_table) {
        return
      }

      const targetObject = column.fk_table.includes('.') ? column.fk_table : `${schemaName}.${column.fk_table}`
      openTabWithFilter(connId, targetObject, {
        column: column.fk_column,
        op: 'eq',
        value: String(value),
      })
    },
    [connId, openTabWithFilter, schemaName]
  )

  const handleClearFilters = useCallback(() => {
    clearObjectTabFilterState(tabId)
    setOpts(tabId, { filters: [], offset: 0 })
    void fetchData(connId, object, tabId, { filters: [], offset: 0 })
  }, [clearObjectTabFilterState, connId, fetchData, object, setOpts, tabId])

  const handleNavigateBack = useCallback(() => {
    goBackFromTab(tabId)
  }, [goBackFromTab, tabId])

  const handleNavigateReferencedBy = useCallback(
    (reference: FKRef, value: unknown) => {
      if (value === null || value === undefined) {
        return
      }
      openTabWithFilter(connId, reference.table, {
        column: reference.column,
        op: 'eq',
        value: String(value),
      })
    },
    [connId, openTabWithFilter]
  )

  useEffect(() => {
    if (skipFirstFilterFetch.current) {
      skipFirstFilterFetch.current = false
      return
    }

    const timeout = window.setTimeout(() => {
      void fetchData(connId, object, tabId, { filters: activeFilters, offset: 0 })
    }, FILTER_DEBOUNCE_MS)

    return () => window.clearTimeout(timeout)
  }, [activeFilters, connId, fetchData, filterSignature, object, tabId])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r') {
        event.preventDefault()
        refresh()
      }
      if (event.key === 'Escape') {
        setActiveDDLDialog(null)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [refresh])

  const getDraftValue = useCallback(
    (rowKey: string, columnName: string, fallback: unknown) =>
      draftCellValue(draftUpdates, rowKey, columnName, fallback),
    [draftUpdates]
  )

  const isDirtyCell = useCallback(
    (rowKey: string, columnName: string) => Boolean(draftUpdates[rowKey] && columnName in draftUpdates[rowKey].data),
    [draftUpdates]
  )

  const handleCellChange = useCallback(
    (rowKey: string, columnName: string, value: unknown) => {
      if (!editMode || !hasPrimaryKey) return
      const identity = rowEntryByKey.get(rowKey)?.identity
      if (!identity) {
        setLocalError('Cannot edit this row: primary key value is missing.')
        return
      }
      setDraftCell(tabId, rowKey, identity.where, columnName, value)
    },
    [editMode, hasPrimaryKey, rowEntryByKey, setDraftCell, tabId]
  )

  const handleToggleRow = useCallback(
    (rowKey: string, checked: boolean) => {
      if (!hasPrimaryKey) return
      const entry = rowEntryByKey.get(rowKey)
      if (!entry?.identity) return

      setSelectedRows((prev) => {
        const next = new Map(prev)
        if (checked) {
          next.set(rowKey, { where: entry.identity.where, row: entry.row })
        } else {
          next.delete(rowKey)
        }
        return next
      })
    },
    [hasPrimaryKey, rowEntryByKey]
  )

  const handleToggleAll = useCallback(
    (rowKeys: string[], checked: boolean) => {
      if (!hasPrimaryKey) return
      setSelectedRows((prev) => {
        const next = new Map(prev)
        rowKeys.forEach((rowKey) => {
          const entry = rowEntryByKey.get(rowKey)
          if (!entry?.identity) return
          if (checked) {
            next.set(rowKey, { where: entry.identity.where, row: entry.row })
          } else {
            next.delete(rowKey)
          }
        })
        return next
      })
    },
    [hasPrimaryKey, rowEntryByKey]
  )

  const handleDeleteSelected = useCallback(() => {
    if (selectedRows.size === 0) return
    if (!hasPrimaryKey) {
      setLocalError('Delete is disabled for tables without primary key.')
      return
    }
    if (editMode) {
      selectedRows.forEach((selected, rowKey) => {
        toggleDraftDelete(tabId, rowKey, selected.where, true)
      })
      setSelectedRows(new Map())
      return
    }
    setShowDeleteDialog(true)
  }, [editMode, hasPrimaryKey, selectedRows, tabId, toggleDraftDelete])

  const confirmImmediateDelete = useCallback(async () => {
    if (!hasPrimaryKey) {
      setLocalError('Delete is disabled for tables without primary key.')
      return
    }

    setIsSaving(true)
    setLocalError(null)
    try {
      for (const selected of selectedRows.values()) {
        await mutate(
          connId,
          {
            type: 'delete',
            schema: schemaName,
            object: tableName,
            where: selected.where,
          },
          tabId,
          { reload: false }
        )
      }
      setSelectedRows(new Map())
      setShowDeleteDialog(false)
      await fetchData(connId, object, tabId)
    } catch (e) {
      setLocalError((e as Error).message)
    } finally {
      setIsSaving(false)
    }
  }, [connId, fetchData, hasPrimaryKey, mutate, object, schemaName, selectedRows, tabId, tableName])

  const handleToggleEditMode = useCallback(() => {
    if (editMode && pendingCount > 0) {
      setLocalError('You have pending draft changes. Save all or Cancel all first.')
      return
    }
    setEditMode((current) => !current)
    setLocalError(null)
  }, [editMode, pendingCount])

  const handleCancelAll = useCallback(() => {
    clearDrafts(tabId)
    setSelectedRows(new Map())
    setEditMode(false)
    setLocalError(null)
  }, [clearDrafts, tabId])

  const handleSaveAll = useCallback(async () => {
    const payload = buildBulkMutatePayload(schemaName, tableName, draftUpdates, draftDeletes, draftInserts)
    if (payload.operations.length === 0) {
      setShowSaveDialog(false)
      return
    }

    setIsSaving(true)
    setLocalError(null)
    try {
      await mutateBulk(connId, payload, tabId, { reload: false })
      clearDrafts(tabId)
      setSelectedRows(new Map())
      setEditMode(false)
      setShowSaveDialog(false)
      await fetchData(connId, object, tabId)
    } catch (e) {
      setLocalError((e as Error).message)
    } finally {
      setIsSaving(false)
    }
  }, [clearDrafts, connId, draftDeletes, draftInserts, draftUpdates, fetchData, mutateBulk, object, schemaName, tabId, tableName])

  const handleAddRowSubmit = useCallback(
    async (data: Record<string, unknown>) => {
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
          tabId,
          { reload: false }
        )
        setShowAddDialog(false)
        await fetchData(connId, object, tabId)
      } catch (e) {
        setLocalError((e as Error).message)
        throw e
      } finally {
        setIsSaving(false)
      }
    },
    [connId, editMode, fetchData, mutate, object, schemaName, stageInsert, tabId, tableName]
  )

  const handleDDLSuccess = useCallback(
    async (title: string, message: string, closeCurrentTab = false) => {
      await refreshTree(connId)
      if (closeCurrentTab) {
        closeTab(tabId)
      } else {
        await fetchSchema(connId, object, tabId)
        await fetchData(connId, object, tabId)
      }
      pushToast({ tone: 'success', title, message })
      setActiveDDLDialog(null)
    },
    [closeTab, connId, fetchData, fetchSchema, object, pushToast, refreshTree, tabId]
  )

  const handleDDLAction = useCallback((action: DDLDialog) => {
    setLocalError(null)
    if (action === 'drop_column' && columns.length === 0) {
      setLocalError('There are no columns available to drop.')
      return
    }
    setActiveDDLDialog(action)
  }, [columns.length])

  const submitAddColumn = useCallback(
    async (payload: { name: string; type: string; nullable: boolean; default?: string }) => {
      setIsSaving(true)
      setLocalError(null)
      try {
        await ddl(connId, {
          type: 'add_column',
          schema: schemaName,
          object: tableName,
          params: payload,
        })
        await handleDDLSuccess('Column added', `${payload.name} was added to ${schemaName}.${tableName}.`)
      } catch (e) {
        const message = (e as Error).message
        setLocalError(message)
        pushToast({ tone: 'error', title: 'Add column failed', message })
        throw e
      } finally {
        setIsSaving(false)
      }
    },
    [connId, ddl, handleDDLSuccess, pushToast, schemaName, tableName]
  )

  const submitCreateIndex = useCallback(
    async (payload: { name: string; columns: string[]; unique: boolean }) => {
      setIsSaving(true)
      setLocalError(null)
      try {
        await ddl(connId, {
          type: 'create_index',
          schema: schemaName,
          object: tableName,
          params: payload,
        })
        await handleDDLSuccess('Index created', `${payload.name} was created for ${schemaName}.${tableName}.`)
      } catch (e) {
        const message = (e as Error).message
        setLocalError(message)
        pushToast({ tone: 'error', title: 'Create index failed', message })
        throw e
      } finally {
        setIsSaving(false)
      }
    },
    [connId, ddl, handleDDLSuccess, pushToast, schemaName, tableName]
  )

  const submitDangerousDDL = useCallback(
    async (dialog: Extract<DDLDialog, 'drop_table' | 'drop_column'>, target: string) => {
      setIsSaving(true)
      setLocalError(null)
      try {
        if (dialog === 'drop_table') {
          await ddl(connId, {
            type: 'drop_table',
            schema: schemaName,
            object: tableName,
            params: {},
          })
          await handleDDLSuccess('Table dropped', `${schemaName}.${tableName} was removed.`, true)
        }
        if (dialog === 'drop_column') {
          if (!target.trim()) {
            throw new Error('Column name is required.')
          }
          await ddl(connId, {
            type: 'drop_column',
            schema: schemaName,
            object: tableName,
            params: { name: target.trim() },
          })
          await handleDDLSuccess('Column dropped', `${target.trim()} was removed from ${schemaName}.${tableName}.`)
        }
      } catch (e) {
        const message = (e as Error).message
        setLocalError(message)
        pushToast({ tone: 'error', title: 'Drop action failed', message })
        throw e
      } finally {
        setIsSaving(false)
      }
    },
    [connId, ddl, handleDDLSuccess, pushToast, schemaName, tableName]
  )

  const exportColumns = useMemo<ExportColumn[]>(
    () => columns.map((column) => ({ name: column.name, type: column.data_type })),
    [columns]
  )
  // Copy/export reproduce what the grid is SHOWING, which in edit mode means the
  // unsaved draft rather than the value it replaced -- the same rule EditableCell
  // renders by. rowKey is passed explicitly for selected rows, whose row objects
  // may come from a page that is no longer loaded and so are not in rowKeyByRow.
  const toExportRow = useCallback(
    (row: TableRow, rowKey?: string) => {
      const key = rowKey ?? rowKeyByRow.get(row)
      return columns.map((column) => draftCellValue(draftUpdates, key, column.name, row[column.name]))
    },
    [columns, draftUpdates, rowKeyByRow]
  )
  // Insertion order, i.e. the order the rows were checked in. Every checked row
  // is here regardless of which page it was checked on, so this list always has
  // exactly `selectedRows.size` entries -- the number the menu shows. Values come
  // from the loaded page where it has the row, so a Refresh cannot leave the
  // clipboard describing what the grid stopped showing -- see resolveSelectedRows.
  const selectedRowEntries = useMemo(
    () => resolveSelectedRows(selectedRows, (rowKey) => rowEntryByKey.get(rowKey)?.row),
    [rowEntryByKey, selectedRows]
  )

  const copyText = useCallback(
    async (text: string, successMessage: string) => {
      const copied = await writeClipboardText(text)
      if (copied) {
        pushToast({ tone: 'success', title: 'Copied', message: successMessage })
      } else {
        pushToast({ tone: 'error', title: 'Copy failed', message: clipboardFailureMessage() })
      }
    },
    [pushToast]
  )

  const handleCopyCell = useCallback(
    (value: unknown) => {
      void copyText(copySingleCellText(value), 'Cell copied to clipboard.')
    },
    [copyText]
  )

  const handleCopyRow = useCallback(
    (row: TableRow, format: 'tsv' | 'json') => {
      const exportRows = [toExportRow(row)]
      void copyText(
        format === 'tsv' ? buildTSV(exportColumns, exportRows) : buildJSON(exportColumns, exportRows),
        'Row copied to clipboard.'
      )
    },
    [copyText, exportColumns, toExportRow]
  )

  const handleCopy = useCallback(
    (format: 'tsv' | 'json', scope: 'all' | 'selected') => {
      const exportRows =
        scope === 'all'
          ? rows.map((row) => toExportRow(row))
          : selectedRowEntries.map((entry) => toExportRow(entry.row, entry.rowKey))
      const text = format === 'tsv' ? buildTSV(exportColumns, exportRows) : buildJSON(exportColumns, exportRows)
      void copyText(text, `${exportRows.length} row${exportRows.length === 1 ? '' : 's'} copied to clipboard.`)
    },
    [copyText, exportColumns, rows, selectedRowEntries, toExportRow]
  )

  const handleExport = useCallback(
    (format: 'csv' | 'json') => {
      const exportRows = rows.map((row) => toExportRow(row))
      const stamp = timestampForFilename()
      const content = format === 'csv' ? buildCSV(exportColumns, exportRows) : buildJSON(exportColumns, exportRows)
      const mime = format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8'
      downloadTextFile(`${tableName}-${stamp}.${format}`, mime, content)
      pushToast({
        tone: 'success',
        title: 'Exported',
        message: `${exportRows.length} row${exportRows.length === 1 ? '' : 's'} exported as ${format.toUpperCase()}.`,
      })
    },
    [exportColumns, pushToast, rows, tableName, toExportRow]
  )

  const isInitialLoad = isLoading && rows.length === 0 && !error
  const classifiedLoadError = error ? classifyDataLoadError(error) : null

  if (error && rows.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-xl space-y-4">
          <ErrorBanner message={classifiedLoadError?.bannerMessage ?? error} onRetry={refresh} />
          <EmptyState
            variant="no_data"
            title={classifiedLoadError?.title ?? 'Unable to load table'}
            description={
              classifiedLoadError?.description ??
              'The current table did not load. Retry once the connection and database are available.'
            }
          />
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <FkBreadcrumb
        items={activeTab?.navigationTrail ?? []}
        onBack={handleNavigateBack}
      />

      <Toolbar
        onRefresh={refresh}
        onAddRow={() => setShowAddDialog(true)}
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
        onDDLAction={handleDDLAction}
        canOpenReferencedBy={canOpenReferencedBy}
        onOpenReferencedBy={() => setShowReferencedByDialog(true)}
        loadedRowCount={rows.length}
        onCopy={handleCopy}
        onExport={handleExport}
      />

      {localError && <div className="mx-2 mt-2"><ErrorBanner message={localError} onDismiss={() => setLocalError(null)} /></div>}

      {activeFilters.length > 0 && (
        <div className="mx-2 mt-2 flex items-center justify-between rounded border border-blue-500/20 bg-blue-500/5 px-3 py-2">
          <div className="min-w-0 truncate text-xs text-blue-200">
            <span className="font-medium text-blue-300">Filtered by:</span> {filterBadgeLabel}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-[11px] text-blue-200 hover:text-blue-100"
            onClick={handleClearFilters}
          >
            <X className="h-3.5 w-3.5" />
            Clear
          </Button>
        </div>
      )}

      <div className="relative flex flex-1 flex-col overflow-hidden p-1">
        {isInitialLoad ? (
          <div className="flex-1 overflow-auto p-2">
            <LoadingSkeleton variant="table" />
          </div>
        ) : total === 0 ? (
          <div className="flex flex-1 items-center justify-center p-4">
            <div className="w-full max-w-md">
              <EmptyState
                variant={activeFilters.length > 0 ? 'no_results' : 'no_data'}
                actionLabel={activeFilters.length > 0 ? 'Clear Filters' : undefined}
                onAction={
                  activeFilters.length > 0
                    ? () => {
                        setOpts(tabId, { filters: [], offset: 0 })
                        void fetchData(connId, object, tabId, { filters: [], offset: 0 })
                        clearObjectTabFilterState(tabId)
                      }
                    : undefined
                }
              />
            </div>
          </div>
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            loading={isLoading || isSaving}
            sorting={sorting}
            filterState={filterState}
            selectedRows={selectedRowKeys}
            editMode={editMode && hasPrimaryKey}
            draftDeletes={deletedRowKeys}
            canSelectRows={hasPrimaryKey}
            getRowKey={getRowKey}
            onSortChange={handleSortChange}
            onFilterChange={handleFilterStateChange}
            onToggleRow={handleToggleRow}
            onToggleAll={handleToggleAll}
            onCellChange={handleCellChange}
            getDraftValue={getDraftValue}
            isDirtyCell={isDirtyCell}
            onNavigateToFk={handleNavigateToFk}
            onCellContextMenu={(row, columnName, value, event) => {
              event.preventDefault()
              setLinkMenu({ x: event.clientX, y: event.clientY, row, column: columnName, value })
            }}
          />
        )}
      </div>

      {draftInserts.length > 0 && (
        <div className="mx-2 mb-2 rounded border border-border bg-muted/20 p-2">
          <div className="mb-1 text-xs font-medium text-foreground">Staged inserts: {draftInserts.length}</div>
          <div className="space-y-1">
            {draftInserts.map((rowDraft, index) => (
              <div key={index} className="flex items-center justify-between rounded border border-border bg-background px-2 py-1">
                <span className="truncate text-xs text-muted-foreground">
                  {Object.entries(rowDraft)
                    .slice(0, 3)
                    .map(([key, value]) => `${key}=${String(value)}`)
                    .join(', ')}
                </span>
                <button
                  type="button"
                  className="ml-2 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => removeStagedInsert(tabId, index)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <PaginationBar
        offset={currentOffset}
        limit={currentLimit}
        total={total}
        hasMore={hasMore}
        onPrev={handlePrev}
        onNext={handleNext}
      />

      <ReferencedByDialog
        open={showReferencedByDialog}
        connId={connId}
        row={selectedRowEntry?.row ?? null}
        references={referencedBy}
        onOpenChange={setShowReferencedByDialog}
        onNavigate={handleNavigateReferencedBy}
      />

      <ConfirmDialog
        open={showDeleteDialog}
        title="Delete selected rows?"
        description={
          <>
            This action cannot be undone. {selectedRows.size} {selectedRows.size === 1 ? 'row' : 'rows'} will be
            deleted from <span className="font-mono">{object}</span>.
          </>
        }
        confirmLabel="Delete"
        destructive
        busy={isSaving}
        onOpenChange={setShowDeleteDialog}
        onConfirm={() => void confirmImmediateDelete()}
      />

      <ConfirmDialog
        open={showSaveDialog}
        title="Apply pending changes?"
        description="Changes will be written to the database in a single bulk transaction."
        confirmLabel="Apply changes"
        busy={isSaving}
        onOpenChange={setShowSaveDialog}
        onConfirm={handleSaveAll}
      />

      <AddRowDialog
        open={showAddDialog}
        object={object}
        columns={columns}
        editMode={editMode}
        saving={isSaving}
        onClose={() => setShowAddDialog(false)}
        onSubmit={handleAddRowSubmit}
      />

      <AddColumnForm
        open={activeDDLDialog === 'add_column'}
        tableName={object}
        saving={isSaving}
        onOpenChange={(open) => setActiveDDLDialog(open ? 'add_column' : null)}
        onSubmit={submitAddColumn}
      />

      <CreateIndexForm
        open={activeDDLDialog === 'create_index'}
        tableName={object}
        columns={columns}
        saving={isSaving}
        onOpenChange={(open) => setActiveDDLDialog(open ? 'create_index' : null)}
        onSubmit={submitCreateIndex}
      />

      <DropConfirmDialog
        open={activeDDLDialog === 'drop_table'}
        title="Drop Table"
        description={`Delete ${schemaName}.${tableName} from the database.`}
        targetLabel="table name"
        expectedValue={tableName}
        saving={isSaving}
        onOpenChange={(open) => setActiveDDLDialog(open ? 'drop_table' : null)}
        onConfirm={(target) => submitDangerousDDL('drop_table', target)}
      />

      <DropConfirmDialog
        open={activeDDLDialog === 'drop_column'}
        title="Drop Column"
        description={`Delete a column from ${schemaName}.${tableName}.`}
        targetLabel="column"
        expectedValue=""
        choices={columns.map((column) => column.name)}
        saving={isSaving}
        onOpenChange={(open) => setActiveDDLDialog(open ? 'drop_column' : null)}
        onConfirm={(target) => submitDangerousDDL('drop_column', target)}
      />

      {linkMenu && (
        <FloatingMenu x={linkMenu.x} y={linkMenu.y} onClose={() => setLinkMenu(null)}>
          <FloatingMenuLabel>Copy</FloatingMenuLabel>
          {linkMenu.column && (
            <FloatingMenuItem
              onClick={() => {
                handleCopyCell(linkMenu.value)
                setLinkMenu(null)
              }}
            >
              Copy cell
            </FloatingMenuItem>
          )}
          <FloatingMenuItem
            onClick={() => {
              handleCopyRow(linkMenu.row, 'tsv')
              setLinkMenu(null)
            }}
          >
            Copy row (TSV)
          </FloatingMenuItem>
          <FloatingMenuItem
            onClick={() => {
              handleCopyRow(linkMenu.row, 'json')
              setLinkMenu(null)
            }}
          >
            Copy row (JSON)
          </FloatingMenuItem>
          <FloatingMenuSeparator />
          <FloatingMenuLabel>Open linked record</FloatingMenuLabel>
          {tableLinks.length === 0 && <FloatingMenuItem disabled>No links for this table</FloatingMenuItem>}
          {tableLinks.map((link: LinkRecord) => {
            const value = extractPgColumn(columns, linkMenu.row, link.source_field ?? '')
            return (
              <FloatingMenuItem
                key={link.id}
                disabled={value === null}
                onClick={() => {
                  if (value !== null) openLinkTarget(link, value)
                  setLinkMenu(null)
                }}
              >
                {value === null ? `${linkTargetLabel(link, null)} (field missing)` : linkTargetLabel(link, value)}
              </FloatingMenuItem>
            )
          })}
          {reverseLinks.length > 0 && <FloatingMenuSeparator />}
          {reverseLinks.length > 0 && <FloatingMenuLabel>Back to source</FloatingMenuLabel>}
          {reverseLinks.map((link: LinkRecord) => {
            const value = extractPgColumn(columns, linkMenu.row, link.column ?? '')
            return (
              <FloatingMenuItem
                key={`rev-${link.id}`}
                disabled={value === null}
                onClick={() => {
                  if (value !== null) openLinkSource(link, value)
                  setLinkMenu(null)
                }}
              >
                {value === null ? `${linkSourceLabel(link, null)} (no value)` : linkSourceLabel(link, value)}
              </FloatingMenuItem>
            )
          })}
          <FloatingMenuSeparator />
          <FloatingMenuItem
            onClick={() => {
              setLinkMenu(null)
              setCreateLinkOpen(true)
            }}
          >
            + Create link…
          </FloatingMenuItem>
        </FloatingMenu>
      )}

      <CreateLinkDialog
        open={createLinkOpen}
        sourceConnId={connId}
        sourceKind="postgres"
        sourceScope={object}
        sourceFieldOptions={columnNames}
        onOpenChange={setCreateLinkOpen}
      />
    </div>
  )
}
