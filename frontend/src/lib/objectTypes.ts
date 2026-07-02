import type { ObjectType, RedisObjectType } from '@/types/api'

export const redisObjectTypes: RedisObjectType[] = [
  'redis_string',
  'redis_hash',
  'redis_list',
  'redis_set',
  'redis_zset',
  'redis_stream',
  'redis_json',
]

export function isRedisObjectType(type: ObjectType | string | undefined): type is RedisObjectType {
  return typeof type === 'string' && redisObjectTypes.includes(type as RedisObjectType)
}

export function isRedisNamespace(type: ObjectType | string | undefined): boolean {
  return type === 'namespace'
}

export function getObjectTypeLabel(type: ObjectType | string | undefined): string {
  switch (type) {
    case 'table':
      return 'table'
    case 'view':
      return 'view'
    case 'index':
      return 'index'
    case 'namespace':
      return 'namespace'
    case 'redis_string':
      return 'string'
    case 'redis_hash':
      return 'hash'
    case 'redis_list':
      return 'list'
    case 'redis_set':
      return 'set'
    case 'redis_zset':
      return 'zset'
    case 'redis_stream':
      return 'stream'
    case 'redis_json':
      return 'json'
    default:
      return type ?? 'object'
  }
}

export function getRedisObjectTypeDisplay(type: RedisObjectType): string {
  return getObjectTypeLabel(type)
}
