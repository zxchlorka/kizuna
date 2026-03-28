export interface Connection {
  id: string
  name: string
  type: string
  host: string
  port: number
  database: string
  username: string
}

export interface ConnectionInput {
  name: string
  type: string
  host: string
  port: number
  database: string
  username: string
  password: string
}

export interface TestResult {
  ok: boolean
  error?: string
  latency_ms: number
}

export interface ObjectItem {
  name: string
  type: string
  schema: string
  row_count: number
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

export interface Schema {
  columns: ColumnMeta[]
}

export interface DataResult {
  columns: ColumnMeta[]
  rows: any[][]
  total: number
  has_more: boolean
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
  op: 'eq' | 'neq' | 'gt' | 'lt' | 'like' | 'contains' | 'is_null' | 'is_not_null'
  value: string
}

export interface MutateOp {
  type: 'insert' | 'update' | 'delete'
  schema: string
  object: string
  where?: Record<string, any>
  data?: Record<string, any>
}

export interface MutateResult {
  rows_affected: number
  row?: any[]
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
