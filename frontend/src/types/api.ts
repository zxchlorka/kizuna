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
