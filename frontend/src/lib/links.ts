// extractMessageField parses a Kafka message JSON value and returns the scalar
// at a dot-path (e.g. "user_id", "user.id"). Returns null when the value is not
// JSON, the path is missing, or the leaf is not a scalar.
export function extractMessageField(value: string, field: string): string | null {
  if (!field) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  let current: unknown = parsed
  for (const part of field.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      return null
    }
    current = (current as Record<string, unknown>)[part]
    if (current === undefined) {
      return null
    }
  }
  if (current === null || typeof current === 'object') {
    return null
  }
  return String(current)
}

// buildRedisKey replaces the single '*' in a pattern with the value.
export function buildRedisKey(pattern: string, value: string): string {
  return pattern.replace('*', value)
}
