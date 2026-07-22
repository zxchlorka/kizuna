// Client-side JSON schema sampler for the Kafka message field picker (Task 6).
//
// Given a set of already-loaded Kafka message rows, this builds a single merged
// schema tree describing the shape of their JSON payloads: which keys exist, the
// value types observed at each position, how often each field appears, and a
// short example value. It powers the "Choose field" picker so the user can click
// through nested objects/arrays to a canonical path instead of typing it by hand.
//
// Design constraints (see the Task 6 brief):
//   - Only rows whose format is 'json' are parsed. Everything else is ignored.
//   - The sample is capped (DEFAULT_SAMPLE_CAP) and the walk is bounded by depth,
//     total node count and example length, so a hostile or enormous payload can
//     never block the main thread.
//   - Differing payload shapes across sampled rows are merged into ONE tree; a
//     key that is a string in one message and a number in another appears once
//     with both types recorded.
//   - Array elements fold into a single '[]' child node (matching the
//     {type:'index'} segment in jsonPaths.ts) rather than one node per index.
//   - The source rows are never mutated — the tree is a fresh, read-only view.
//
// The emitted node paths are canonical (formatPath from jsonPaths.ts), so a
// selected leaf yields exactly the string the Go/TS matchers understand, e.g.
// src.event_data.events[].name.

import { formatPath, type PathSegment } from '@/lib/jsonPaths'

// The shape categories a value can fall into. Scalars (string/number/boolean/
// null) are selectable leaves; object/array are structural and expand.
export type JsonTypeCategory = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array'

// A single position in the merged schema tree.
export interface SchemaNode {
  // Canonical path from the root, e.g. "src.event_data.events[].name". Empty for
  // the synthetic root node.
  path: string
  // Last segment, for display: an object key, or "[]" for the array-item node.
  label: string
  // Parsed segments backing `path` (kept so callers don't have to re-parse).
  segments: PathSegment[]
  // Every value category observed at this position across the sample, in a
  // stable display order.
  types: JsonTypeCategory[]
  // How many sampled messages had SOME value at this path (counted once per
  // message even when an array fans the path out to many elements).
  seenCount: number
  // Denominator for `seenCount`: how many messages were successfully sampled.
  // Identical on every node in a given tree.
  sampleCount: number
  // A short, whitespace-collapsed example scalar, if one was observed.
  example?: string
  // True only for scalar/null leaves — the only positions that make sense as a
  // search target.
  selectable: boolean
  // True when the node has children to expand (object keys and/or an "[]" child).
  expandable: boolean
  children: SchemaNode[]
}

// The minimal row shape the sampler needs. KafkaMessageRow satisfies this
// structurally, so the sampler stays decoupled from the store and unit-testable.
export interface SampleRow {
  format: string
  value: string
}

export interface SchemaSampleResult {
  root: SchemaNode
  // Messages successfully parsed and merged (the seen/sample denominator).
  sampleCount: number
  // json-format rows considered (<= cap), including any that failed to parse.
  jsonRowCount: number
  // True if a depth or node-count limit pruned part of the tree.
  truncated: boolean
}

export interface SampleOptions {
  sampleCap?: number
  maxDepth?: number
  maxNodes?: number
  exampleMaxLength?: number
}

// Concrete bounds. Rationale (stated in the report):
//   - SAMPLE_CAP 200: recommended by the plan; enough shape coverage without
//     parsing an unbounded page.
//   - MAX_DEPTH 12: the deepest real path in the docs/msg.json fixture
//     (src.event_data.events[].data.items[].tail_object.terms.search_text) is
//     depth 10, so 12 reaches everything real while still bounding recursion on
//     pathological nesting.
//   - MAX_NODES 4000: "low thousands" — a real message has well under a hundred
//     distinct paths, so 4000 is generous headroom that still caps a payload
//     built to explode the key space.
//   - EXAMPLE_MAX_LENGTH 120: matches the browser's existing value preview.
export const DEFAULT_SAMPLE_CAP = 200
export const DEFAULT_MAX_DEPTH = 12
export const DEFAULT_MAX_NODES = 4000
export const DEFAULT_EXAMPLE_MAX_LENGTH = 120

const TYPE_ORDER: JsonTypeCategory[] = ['string', 'number', 'boolean', 'null', 'object', 'array']

interface BuilderNode {
  segments: PathSegment[]
  label: string
  types: Set<JsonTypeCategory>
  seenCount: number
  example: string | undefined
  keyChildren: Map<string, BuilderNode>
  arrayChild: BuilderNode | null
  // Index of the last document that touched this node, so seenCount is counted
  // at most once per message even under array fan-out.
  lastSeenDoc: number
}

interface WalkContext {
  maxDepth: number
  maxNodes: number
  exampleMaxLength: number
  nodeCount: number
  truncated: boolean
  docIndex: number
}

function categorize(value: unknown): JsonTypeCategory {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  switch (typeof value) {
    case 'string':
      return 'string'
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    default:
      return 'object'
  }
}

function isScalarCategory(category: JsonTypeCategory): boolean {
  return category === 'string' || category === 'number' || category === 'boolean' || category === 'null'
}

// exampleFor renders a scalar/null as a short, single-line preview string.
function exampleFor(value: unknown, maxLength: number): string {
  const raw = typeof value === 'string' ? value : String(value)
  const collapsed = raw.replace(/\s+/g, ' ').trim()
  return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength)}…` : collapsed
}

function makeBuilder(segments: PathSegment[], label: string): BuilderNode {
  return {
    segments,
    label,
    types: new Set(),
    seenCount: 0,
    example: undefined,
    keyChildren: new Map(),
    arrayChild: null,
    lastSeenDoc: -1,
  }
}

// walk merges one value at `node`'s position into the builder tree.
function walk(node: BuilderNode, value: unknown, depth: number, ctx: WalkContext): void {
  const category = categorize(value)
  node.types.add(category)

  // Count this node as "seen" once per document, even if a parent array fans the
  // path out to many elements within the same message.
  if (node.lastSeenDoc !== ctx.docIndex) {
    node.lastSeenDoc = ctx.docIndex
    node.seenCount += 1
  }

  if (isScalarCategory(category)) {
    const example = exampleFor(value, ctx.exampleMaxLength)
    // Prefer the first example, but upgrade from an empty string to a real one.
    if (node.example === undefined || (node.example === '' && example !== '')) {
      node.example = example
    }
    return
  }

  if (depth >= ctx.maxDepth) {
    ctx.truncated = true
    return
  }

  if (category === 'object') {
    const obj = value as Record<string, unknown>
    for (const key of Object.keys(obj)) {
      let child = node.keyChildren.get(key)
      if (!child) {
        if (ctx.nodeCount >= ctx.maxNodes) {
          ctx.truncated = true
          continue
        }
        child = makeBuilder([...node.segments, { type: 'key', key }], key)
        node.keyChildren.set(key, child)
        ctx.nodeCount += 1
      }
      walk(child, obj[key], depth + 1, ctx)
    }
    return
  }

  // Array: fold every element into a single '[]' child node.
  const arr = value as unknown[]
  let child = node.arrayChild
  if (!child) {
    if (ctx.nodeCount >= ctx.maxNodes) {
      ctx.truncated = true
      return
    }
    child = makeBuilder([...node.segments, { type: 'index' }], '[]')
    node.arrayChild = child
    ctx.nodeCount += 1
  }
  for (const element of arr) {
    walk(child, element, depth + 1, ctx)
  }
}

function sortTypes(types: Set<JsonTypeCategory>): JsonTypeCategory[] {
  return [...types].sort((a, b) => TYPE_ORDER.indexOf(a) - TYPE_ORDER.indexOf(b))
}

function finalize(node: BuilderNode, sampleCount: number): SchemaNode {
  const children: SchemaNode[] = []
  const keys = [...node.keyChildren.keys()].sort((a, b) => a.localeCompare(b))
  for (const key of keys) {
    children.push(finalize(node.keyChildren.get(key)!, sampleCount))
  }
  // The array-item node sorts after object keys (a pure array node has only it).
  if (node.arrayChild) {
    children.push(finalize(node.arrayChild, sampleCount))
  }

  const types = sortTypes(node.types)
  const hasScalar = types.some(isScalarCategory)

  return {
    path: formatPath(node.segments),
    label: node.label,
    segments: node.segments,
    types,
    seenCount: node.seenCount,
    sampleCount,
    example: node.example,
    // The synthetic root (no segments) is never selectable.
    selectable: hasScalar && node.segments.length > 0,
    expandable: children.length > 0,
    children,
  }
}

// buildSchemaTree samples the JSON payloads of the given rows and returns a
// merged schema tree. It never mutates `rows` or their elements.
export function buildSchemaTree(rows: readonly SampleRow[], options: SampleOptions = {}): SchemaSampleResult {
  const sampleCap = options.sampleCap ?? DEFAULT_SAMPLE_CAP
  const ctx: WalkContext = {
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxNodes: options.maxNodes ?? DEFAULT_MAX_NODES,
    exampleMaxLength: options.exampleMaxLength ?? DEFAULT_EXAMPLE_MAX_LENGTH,
    nodeCount: 0,
    truncated: false,
    docIndex: -1,
  }

  // Collect up to `sampleCap` json-format rows without touching the source array.
  const jsonRows: SampleRow[] = []
  for (const row of rows) {
    if (row && row.format === 'json') {
      jsonRows.push(row)
      if (jsonRows.length >= sampleCap) break
    }
  }

  const root = makeBuilder([], '')
  let parsed = 0
  jsonRows.forEach((row, index) => {
    let value: unknown
    try {
      value = JSON.parse(row.value)
    } catch {
      // Unparseable json-format rows contribute nothing but still counted in
      // jsonRowCount so the UI can note them if it wants.
      return
    }
    ctx.docIndex = index
    walk(root, value, 0, ctx)
    parsed += 1
  })

  return {
    root: finalize(root, parsed),
    sampleCount: parsed,
    jsonRowCount: jsonRows.length,
    truncated: ctx.truncated,
  }
}

// findNode looks up a node by canonical path within a tree — a small helper for
// callers and tests. Returns null when the path is not present in the tree.
export function findNode(root: SchemaNode, path: string): SchemaNode | null {
  if (root.path === path) return root
  for (const child of root.children) {
    const found = findNode(child, path)
    if (found) return found
  }
  return null
}
