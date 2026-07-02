export function normalizeVisibleSchemasSelection(
  availableSchemas: string[],
  selectedSchemas: string[] | null
): string[] | null {
  if (selectedSchemas === null) {
    return null
  }

  const available = new Set(availableSchemas)
  return selectedSchemas.filter((schema) => available.has(schema))
}
