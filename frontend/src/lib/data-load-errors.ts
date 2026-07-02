interface ClassifiedDataLoadError {
  title: string
  description: string
  bannerMessage: string
}

const PG_STAT_STATEMENTS_NOT_LOADED = 'pg_stat_statements must be loaded via shared_preload_libraries'

export function classifyDataLoadError(message: string): ClassifiedDataLoadError | null {
  const normalized = message.toLowerCase()

  if (normalized.includes(PG_STAT_STATEMENTS_NOT_LOADED)) {
    return {
      title: 'System view is not available',
      description:
        'This PostgreSQL view exists, but the server has not loaded the required extension in shared_preload_libraries. This is a database configuration issue, not a Kizuna error.',
      bannerMessage: 'This system view requires shared_preload_libraries on the PostgreSQL server.',
    }
  }

  return null
}
