import type { FilterExpr, ObjectType } from '@/types/api'

/**
 * The address bar as a shareable pointer at what is open.
 *
 * An investigation ends with "look at this" — a row, a key, a topic — and until
 * now the only address Kizuna could produce was the connection it lived on. The
 * open tab already carries everything the recipient needs, so it is mirrored
 * into the query string: `?object=public.users&type=table&filter=id.eq.123`.
 *
 * Only object tabs are addressed. A SQL console holds a draft rather than a
 * location, and Overview is one click from the connection itself — neither
 * carries anything a link would have to say.
 */

const OBJECT_PARAM = 'object'
const TYPE_PARAM = 'type'
const FILTER_PARAM = 'filter'

const OBJECT_TYPES: ObjectType[] = [
  'table',
  'view',
  'index',
  'namespace',
  'redis_string',
  'redis_hash',
  'redis_list',
  'redis_set',
  'redis_zset',
  'redis_stream',
  'redis_json',
  'kafka_topic',
  'kafka_partition',
  'kafka_consumer_group',
]

const FILTER_OPS: FilterExpr['op'][] = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'like',
  'contains',
  'is_null',
  'is_not_null',
]

export interface ObjectDeepLink {
  object: string
  objectType: ObjectType
  filters: FilterExpr[]
}

// column.op.value, the shape PostgREST made familiar. Only the first two dots
// separate, so a value may contain as many as it likes — a timestamp, a
// hostname, a decimal. A column name containing a dot is the one case this
// cannot express; such a filter is dropped from the link rather than mangling
// the rest of it.
function encodeFilter(filter: FilterExpr): string {
  return `${filter.column}.${filter.op}.${filter.value}`
}

function decodeFilter(raw: string): FilterExpr | null {
  const firstDot = raw.indexOf('.')
  if (firstDot <= 0) return null
  const secondDot = raw.indexOf('.', firstDot + 1)
  if (secondDot < 0) return null

  const column = raw.slice(0, firstDot)
  const op = raw.slice(firstDot + 1, secondDot)
  const value = raw.slice(secondDot + 1)

  if (!FILTER_OPS.includes(op as FilterExpr['op'])) return null
  return { column, op: op as FilterExpr['op'], value }
}

/** Builds the query string for a tab. Returns empty params for no link. */
export function encodeObjectDeepLink(link: ObjectDeepLink | null): URLSearchParams {
  const params = new URLSearchParams()
  if (!link || !link.object) {
    return params
  }
  params.set(OBJECT_PARAM, link.object)
  params.set(TYPE_PARAM, link.objectType)
  link.filters.forEach((filter) => {
    if (!filter.column.includes('.')) {
      params.append(FILTER_PARAM, encodeFilter(filter))
    }
  })
  return params
}

/**
 * Reads a link out of the query string, or null when there is none.
 *
 * Everything here arrives from someone else's clipboard, so an unknown object
 * type or a malformed filter is dropped rather than trusted: the worst outcome
 * of a bad link should be the wrong tab, never a broken screen.
 */
export function decodeObjectDeepLink(params: URLSearchParams): ObjectDeepLink | null {
  const object = params.get(OBJECT_PARAM)
  if (!object) {
    return null
  }

  const rawType = params.get(TYPE_PARAM) ?? 'table'
  const objectType = OBJECT_TYPES.includes(rawType as ObjectType) ? (rawType as ObjectType) : 'table'

  const filters = params
    .getAll(FILTER_PARAM)
    .map(decodeFilter)
    .filter((filter): filter is FilterExpr => filter !== null)

  return { object, objectType, filters }
}
