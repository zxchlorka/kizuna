import { normalizeVisibleSchemasSelection } from '../src/lib/objectTreeVisibleSchemas.js'

function assertDeepEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

assertDeepEqual(
  normalizeVisibleSchemasSelection(['public', 'analytics'], ['public']),
  ['public'],
  'explicit selection must not be widened by new schemas'
)

assertDeepEqual(
  normalizeVisibleSchemasSelection(['public'], ['public', 'analytics']),
  ['public'],
  'explicit selection must prune removed schemas'
)

assertDeepEqual(
  normalizeVisibleSchemasSelection(['public', 'analytics'], null),
  null,
  'null selection must keep show-all semantics'
)

console.log('objectTreeVisibleSchemas tests passed')
