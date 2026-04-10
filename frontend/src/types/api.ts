export type ObjectType = 'table' | 'view' | 'index'
export type ObjectItemType = ObjectType | 'schema'

export interface Connection {
  id: string
  name: string
  type: string
  host: string
  port: number
  database: string
  username: string
  tags?: string[]
  visible_schemas: string[] | null
}

export interface ConnectionInput {
  name: string
  type: string
  host: string
  port: number
  database: string
  username: string
  password: string
  tags: string[]
  visible_schemas?: string[] | null
}

export interface TestResult {
  ok: boolean
  error?: string
  latency_ms: number
}

export interface ObjectItem {
  name: string
  type: ObjectItemType
  schema: string
  row_count: number
  parent_name?: string
}

export interface ObjectInfo {
  name: string
  schema: string
  object_type: ObjectType
  owner_table?: string
  columns: string[]
  method?: string
  is_unique: boolean
  predicate?: string | null
  definition: string
}

export interface ColumnMeta {
  name: string
  data_type: string
  nullable: boolean
  default: string | null
  is_pk: boolean
  is_fk: boolean
  fk_table: string
  fk_column: string
}

export interface FKRef {
  table: string
  column: string
  ref_column: string
}

export interface Schema {
  columns: ColumnMeta[]
  referenced_by: FKRef[]
}

export type TableRow = Record<string, unknown>

export interface DataResult {
  columns: ColumnMeta[]
  rows: TableRow[]
  total: number
  has_more: boolean
}

export interface ExecResult {
  columns: string[]
  column_types?: string[]
  rows: unknown[][]
  rows_affected: number
  statement?: string
  error?: string
  duration_ms: number
  rows_returned: number
  truncated?: boolean
  applied_limit?: number
  skipped?: boolean
}

export interface ExecuteRequest {
  statement: string
}

export interface ExecuteMultiRequest {
  statements: string[]
}

export interface ExecuteMultiResponse {
  results: ExecResult[]
}

export interface ExplainNode {
  node_type: string
  relation_name?: string
  alias?: string
  startup_cost: number
  total_cost: number
  plan_rows: number
  actual_rows: number
  actual_time_ms: number
  shared_hit_blocks: number
  shared_read_blocks: number
  is_bottleneck?: boolean
  children?: ExplainNode[]
}

export interface ExplainResult {
  plan: ExplainNode
  duration_ms: number
  mode: 'explain' | 'analyze'
}

export interface CompletionItem {
  label: string
  type: 'table' | 'column' | 'function' | 'keyword'
  detail?: string
}

export interface HistoryEntry {
  id: string
  command: string
  duration_ms: number
  rows_returned: number
  rows_affected: number
  error?: string
  executed_at: string
}

export interface DataOpts {
  offset: number
  limit: number
  order_by: string
  order_dir: 'asc' | 'desc'
  filters: FilterExpr[]
}

export interface FilterExpr {
  column: string
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'contains' | 'is_null' | 'is_not_null'
  value: string
}

export interface MutateOp {
  type: 'insert' | 'update' | 'delete'
  schema: string
  object: string
  where?: Record<string, unknown>
  data?: Record<string, unknown>
}

export interface MutateResult {
  rows_affected: number
  row?: unknown[]
}

export interface BulkMutateOp {
  schema: string
  object: string
  operations: MutateOp[]
}

export interface BulkMutateResult {
  applied: number
  rows_affected: number
  message: string
}

export type DDLType =
  | 'create_table'
  | 'drop_table'
  | 'add_column'
  | 'drop_column'
  | 'create_index'
  | 'drop_index'

export interface DDLColumnInput {
  name: string
  type: string
  nullable: boolean
  primary_key: boolean
  default?: unknown
}

export interface DDLOp {
  type: DDLType
  schema: string
  object: string
  params: Record<string, unknown>
}

export interface DDLResult {
  ok: boolean
  type: DDLType
  schema: string
  object: string
}
