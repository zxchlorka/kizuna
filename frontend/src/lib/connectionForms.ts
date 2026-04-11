import type {
  Connection,
  ConnectionInput,
  ConnectionType,
  PostgresConnectionInput,
  RedisConfig,
  RedisConnectionInput,
  RedisMode,
} from '@/types/api'

export interface ConnectionFormValues {
  name: string
  type: ConnectionType
  host: string
  port: string
  database: string
  username: string
  password: string
  tagsText: string
  mode: RedisMode
  separator: string
  tlsEnabled: boolean
  clusterAddressesText: string
  sentinelMasterName: string
  sentinelAddressesText: string
}

const postgresDefaults: ConnectionFormValues = {
  name: '',
  type: 'postgres',
  host: 'localhost',
  port: '5432',
  database: '',
  username: '',
  password: '',
  tagsText: '',
  mode: 'standalone',
  separator: ':',
  tlsEnabled: false,
  clusterAddressesText: '',
  sentinelMasterName: '',
  sentinelAddressesText: '',
}

const redisDefaults: ConnectionFormValues = {
  ...postgresDefaults,
  type: 'redis',
  port: '6379',
  database: '0',
  mode: 'standalone',
  separator: ':',
}

function normalizeTags(value: string): string[] {
  return value
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
}

function normalizeAddresses(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function parsePort(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseDatabase(value: string): number {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

function entrypointFromAddresses(addresses: string[]): { host: string; port: number } {
  const first = addresses[0]?.trim()
  if (!first) {
    return { host: '', port: 0 }
  }

  const normalized = first.startsWith('redis://') ? first.slice('redis://'.length) : first
  const [host, portText] = normalized.split(':')
  const port = Number.parseInt(portText ?? '', 10)

  return {
    host: host?.trim() ?? '',
    port: Number.isFinite(port) && port > 0 ? port : 0,
  }
}

export function createConnectionForm(type: ConnectionType = 'postgres'): ConnectionFormValues {
  return type === 'redis' ? { ...redisDefaults } : { ...postgresDefaults }
}

export function createConnectionFormFromConnection(connection?: Connection): ConnectionFormValues {
  if (!connection) {
    return createConnectionForm('postgres')
  }

  const redisConfig = connection.redis_config

  const base: ConnectionFormValues = {
    ...createConnectionForm(connection.type),
    name: connection.name,
    host: connection.host ?? (connection.type === 'redis' ? 'localhost' : 'localhost'),
    port: String(connection.port ?? (connection.type === 'redis' ? 6379 : 5432)),
    database:
      connection.type === 'redis'
        ? String(
            typeof connection.database === 'number'
              ? connection.database
              : redisConfig?.database ?? 0
          )
        : String(connection.database ?? ''),
    username: connection.username ?? '',
    password: '',
    tagsText: (connection.tags ?? []).join(', '),
    mode: connection.mode ?? redisConfig?.mode ?? 'standalone',
    separator: connection.separator ?? redisConfig?.separator ?? ':',
    tlsEnabled: connection.tlsEnabled ?? redisConfig?.tls_enabled ?? false,
    clusterAddressesText: connection.clusterAddresses?.join('\n') ?? redisConfig?.addresses?.join('\n') ?? '',
    sentinelMasterName: connection.masterName ?? redisConfig?.master_name ?? '',
    sentinelAddressesText: connection.sentinelAddresses?.join('\n') ?? redisConfig?.sentinel_addrs?.join('\n') ?? '',
  }

  return base
}

export function buildConnectionInput(form: ConnectionFormValues): ConnectionInput {
  const tags = normalizeTags(form.tagsText)

  if (form.type === 'redis') {
    const clusterAddresses = normalizeAddresses(form.clusterAddressesText)
    const sentinelAddresses = normalizeAddresses(form.sentinelAddressesText)
    const standalonePort = parsePort(form.port, 6379)
    const derivedEndpoint =
      form.mode === 'cluster'
        ? entrypointFromAddresses(clusterAddresses)
        : form.mode === 'sentinel'
          ? entrypointFromAddresses(sentinelAddresses)
          : { host: form.host.trim(), port: standalonePort }

    const redisConfig: RedisConfig = {
      mode: form.mode,
      separator: form.separator || ':',
      database: parseDatabase(form.database),
      username: form.username.trim(),
      tls_enabled: form.tlsEnabled,
    }

    if (clusterAddresses.length > 0) {
      redisConfig.addresses = clusterAddresses
    }

    if (sentinelAddresses.length > 0) {
      redisConfig.sentinel_addrs = sentinelAddresses
    }

    const sentinelMasterName = form.sentinelMasterName.trim()
    if (sentinelMasterName) {
      redisConfig.master_name = sentinelMasterName
    }

    const redisInput: RedisConnectionInput = {
      name: form.name.trim(),
      type: 'redis',
      host: derivedEndpoint.host,
      port: derivedEndpoint.port,
      database: String(parseDatabase(form.database)),
      username: form.username.trim(),
      password: form.password,
      tags,
      redis_config: redisConfig,
    }
    return redisInput
  }

  const postgresInput: PostgresConnectionInput = {
    name: form.name.trim(),
    type: 'postgres',
    host: form.host.trim(),
    port: parsePort(form.port, 5432),
    database: form.database.trim(),
    username: form.username.trim(),
    password: form.password,
    tags,
  }
  return postgresInput
}

export function validateConnectionForm(form: ConnectionFormValues, allowBlankPassword = false): string | null {
  if (!form.name.trim()) {
    return 'Connection name is required.'
  }

  if (form.type === 'postgres') {
    if (!form.host.trim()) {
      return 'Host is required.'
    }
    if (!Number.isFinite(Number.parseInt(form.port, 10)) || Number.parseInt(form.port, 10) <= 0) {
      return 'Port must be a valid number.'
    }
    if (!form.database.trim()) {
      return 'Database name is required.'
    }
    if (!form.username.trim()) {
      return 'Username is required.'
    }
    return null
  }

  if (form.mode === 'standalone') {
    if (!form.host.trim()) {
      return 'Host is required for standalone Redis.'
    }
    if (!Number.isFinite(Number.parseInt(form.port, 10)) || Number.parseInt(form.port, 10) <= 0) {
      return 'Port must be a valid number.'
    }
    if (!form.database.trim()) {
      return 'Database number is required for standalone Redis.'
    }
    const database = Number.parseInt(form.database, 10)
    if (!Number.isFinite(database) || database < 0 || database > 15) {
      return 'Database must be between 0 and 15.'
    }
  }

  if (form.mode === 'cluster' && normalizeAddresses(form.clusterAddressesText).length === 0) {
    return 'Add at least one cluster broker address.'
  }

  if (form.mode === 'sentinel') {
    if (!form.sentinelMasterName.trim()) {
      return 'Master name is required for sentinel mode.'
    }
    if (normalizeAddresses(form.sentinelAddressesText).length === 0) {
      return 'Add at least one sentinel address.'
    }
  }

  if (!allowBlankPassword && form.username.trim() && !form.password.trim()) {
    return 'Password is required when a username is provided.'
  }

  return null
}

export function splitTags(tagsText: string): string[] {
  return normalizeTags(tagsText)
}

export function splitAddresses(addressesText: string): string[] {
  return normalizeAddresses(addressesText)
}
