/** Final normalized graph shape boundary (#946), after repairs and before session construction. */
import { isPlainObject } from './jsonGuards'
import type {
  BeatDocNode,
  BeatSpec,
  BranchDocNode,
  BranchOption,
  BranchSpec,
  BranchEdge,
  DerivedMeta,
  DialogueDocNode,
  DialogueLine,
  DialogueSpec,
  GeneratedOutput,
  ImageDocNode,
  ImageMeta,
  ImageSpec,
  LabeledMeta,
  NodeType,
  SceneDocNode,
  SceneSpec,
  SequenceEdge,
  ShotDocNode,
  ShotMeta,
  ShotRef,
  ShotRefBase,
  ShotSpec,
  StoryEdge,
  StoryNode,
  AttachEdge,
} from './document'

/** A successful guard establishes the corresponding declared domain shape. */
type Guard<T> = (value: unknown) => value is T

/** Runtime rule entries are data; the generic schema additionally requires every domain key. */
interface RuntimeRule {
  guard: Guard<unknown>
  optional: boolean
}

/** New required or optional domain fields require a matching validator entry at compilation. */
export type NormalizedShapeSchema<T extends object> = {
  [Key in keyof T]-?: {
    guard: Guard<T[Key]>
    optional: Pick<T, never> extends Pick<T, Key> ? true : false
  }
} & Record<string, RuntimeRule>

/** Preserve literal optionality so the domain schema rejects a missing required-field check. */
function field<T, Optional extends boolean>(
  guard: Guard<T>,
  optional: Optional,
) {
  return { guard, optional }
}

/** Own-key checks work with the project's ES2020 library and null-prototype JSON records. */
function owns(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

/** Check known own fields completely while leaving unrelated extension values unchanged. */
function shape<T extends object>(schema: NormalizedShapeSchema<T>): Guard<T> {
  const entries = Object.entries<RuntimeRule>(schema)
  return (value: unknown): value is T =>
    isPlainObject(value) &&
    entries.every(([key, rule]) =>
      owns(value, key) ? rule.guard(value[key]) : rule.optional,
    )
}

/** Empty lists remain valid; every existing member must satisfy the declared element shape. */
function arrayOf<T>(guard: Guard<T>): Guard<T[]> {
  return (value: unknown): value is T[] =>
    Array.isArray(value) && value.every(guard)
}

/** Literal tags preserve the correlation between a union arm and its nested shape. */
function literal<T extends string>(tag: T): Guard<T> {
  return (value: unknown): value is T => value === tag
}

/** Finite enum tables are exhaustive for the declared value domain, including future additions. */
function enumeration<T extends string>(values: Record<T, true>): Guard<T> {
  const accepted: ReadonlySet<unknown> = new Set(Object.keys(values))
  return (value: unknown): value is T => accepted.has(value)
}

/** Scalar guards validate values rather than coercing stored data into a different meaning. */
const text: Guard<string> = (value): value is string =>
  typeof value === 'string'
const boolean: Guard<boolean> = (value): value is boolean =>
  typeof value === 'boolean'
const finite: Guard<number> = (value): value is number => Number.isFinite(value)
const positive: Guard<number> = (value): value is number =>
  finite(value) && value > 0
const sequenceNumber: Guard<number> = (value): value is number =>
  positive(value) && Number.isSafeInteger(value)
/** An empty enum admits no present value, matching optional never fields without a second guard rule. */
const noValue = enumeration<never>({})
const speaker: Guard<string | null> = (value): value is string | null =>
  value === null || text(value)

const timestampFields = {
  createdAt: field(text, true),
  updatedAt: field(text, true),
}
const unlabelledFields = { ...timestampFields, label: field(noValue, true) }
const ungroupedFields = { ...unlabelledFields, episodeNo: field(noValue, true) }
const labelled = shape<LabeledMeta>({
  ...timestampFields,
  label: field(text, false),
  episodeNo: field(sequenceNumber, true),
})
const derived = shape<DerivedMeta>({
  ...unlabelledFields,
  episodeNo: field(sequenceNumber, true),
})
const shotMeta = shape<ShotMeta>(ungroupedFields)
const imageMeta = shape<ImageMeta>(ungroupedFields)

const scene = shape<SceneSpec>({
  sceneNo: field(sequenceNumber, true),
  interior: field(boolean, false),
  locationId: field(text, true),
  time: field(text, true),
  weather: field(text, true),
  synopsis: field(text, false),
  characterIds: field(arrayOf(text), false),
})
const beat = shape<BeatSpec>({ tone: field(text, false) })
const line = shape<DialogueLine>({
  id: field(text, false),
  kind: field(
    enumeration<DialogueLine['kind']>({ line: true, action: true }),
    false,
  ),
  text: field(text, false),
  speaker: field(speaker, true),
  side: field(
    enumeration<NonNullable<DialogueLine['side']>>({ left: true, right: true }),
    true,
  ),
  vo: field(boolean, true),
})
const dialogue = shape<DialogueSpec>({ lines: field(arrayOf(line), false) })
const option = shape<BranchOption>({
  id: field(text, false),
  label: field(text, false),
})
const branch = shape<BranchSpec>({
  prompt: field(text, false),
  options: field(arrayOf(option), false),
})
const refFields = {
  id: field(text, false),
  kind: field(
    enumeration<ShotRefBase['kind']>({
      character: true,
      location: true,
      audio: true,
    }),
    false,
  ),
}
const assetRef = shape<Extract<ShotRef, { assetId: string }>>({
  ...refFields,
  assetId: field(text, false),
  label: field(noValue, true),
})
const freeRef = shape<Extract<ShotRef, { label: string }>>({
  ...refFields,
  label: field(text, false),
  assetId: field(noValue, true),
})
const shotRef: Guard<ShotRef> = (value): value is ShotRef =>
  assetRef(value) || freeRef(value)
const shot = shape<ShotSpec>({
  shotNo: field(sequenceNumber, false),
  size: field(text, false),
  picture: field(text, false),
  prompt: field(text, false),
  refs: field(arrayOf(shotRef), false),
})
const output = shape<GeneratedOutput>({
  assetId: field(text, false),
  width: field(positive, true),
  height: field(positive, true),
})
const image = shape<ImageSpec>({
  prompt: field(text, false),
  model: field(text, false),
  size: field(text, false),
  outputs: field(
    shape<ImageSpec['outputs']>({ primary: field(output, true) }),
    false,
  ),
})
const nodeFields = {
  id: field(text, false),
  layout: field(
    shape<StoryNode['layout']>({
      position: field(
        shape<StoryNode['layout']['position']>({
          x: field(finite, false),
          y: field(finite, false),
        }),
        false,
      ),
      size: field(
        shape<NonNullable<StoryNode['layout']['size']>>({
          width: field(positive, false),
          height: field(positive, false),
        }),
        true,
      ),
      zIndex: field(finite, true),
    }),
    false,
  ),
  ui: field(
    shape<StoryNode['ui']>({
      selected: field(boolean, false),
      expanded: field(boolean, false),
    }),
    false,
  ),
}

/** Every node variant owns a complete schema, so a domain field addition cannot bypass the table. */
const nodeSchemas = {
  scene: shape<SceneDocNode>({
    ...nodeFields,
    type: field(literal('scene'), false),
    data: field(
      shape<SceneDocNode['data']>({
        spec: field(scene, false),
        meta: field(labelled, false),
      }),
      false,
    ),
  }),
  beat: shape<BeatDocNode>({
    ...nodeFields,
    type: field(literal('beat'), false),
    data: field(
      shape<BeatDocNode['data']>({
        spec: field(beat, false),
        meta: field(labelled, false),
      }),
      false,
    ),
  }),
  dialogue: shape<DialogueDocNode>({
    ...nodeFields,
    type: field(literal('dialogue'), false),
    data: field(
      shape<DialogueDocNode['data']>({
        spec: field(dialogue, false),
        meta: field(labelled, false),
      }),
      false,
    ),
  }),
  branch: shape<BranchDocNode>({
    ...nodeFields,
    type: field(literal('branch'), false),
    data: field(
      shape<BranchDocNode['data']>({
        spec: field(branch, false),
        meta: field(derived, false),
      }),
      false,
    ),
  }),
  shot: shape<ShotDocNode>({
    ...nodeFields,
    type: field(literal('shot'), false),
    data: field(
      shape<ShotDocNode['data']>({
        spec: field(shot, false),
        meta: field(shotMeta, false),
      }),
      false,
    ),
  }),
  image: shape<ImageDocNode>({
    ...nodeFields,
    type: field(literal('image'), false),
    data: field(
      shape<ImageDocNode['data']>({
        spec: field(image, false),
        meta: field(imageMeta, false),
      }),
      false,
    ),
  }),
} satisfies { [Type in NodeType]: Guard<Extract<StoryNode, { type: Type }>> }

const nodeChecks = new Map<unknown, Guard<StoryNode>>(
  Object.entries(nodeSchemas),
)

const edgeFields = {
  id: field(text, false),
  source: field(text, false),
  target: field(text, false),
  targetHandle: field(noValue, true),
}
const edgeSchemas = {
  sequence: shape<SequenceEdge>({
    ...edgeFields,
    sourceHandle: field(noValue, true),
    data: field(
      shape<SequenceEdge['data']>({
        kind: field(literal('sequence'), false),
        order: field(finite, true),
      }),
      false,
    ),
  }),
  branch: shape<BranchEdge>({
    ...edgeFields,
    sourceHandle: field(text, false),
    data: field(
      shape<BranchEdge['data']>({
        kind: field(literal('branch'), false),
        order: field(finite, true),
      }),
      false,
    ),
  }),
  attach: shape<AttachEdge>({
    ...edgeFields,
    sourceHandle: field(literal('shots'), false),
    data: field(
      shape<AttachEdge['data']>({
        kind: field(literal('attach'), false),
        order: field(finite, true),
      }),
      false,
    ),
  }),
} satisfies {
  [Kind in StoryEdge['data']['kind']]: Guard<
    Extract<StoryEdge, { data: { kind: Kind } }>
  >
}

const edgeChecks = new Map<unknown, Guard<StoryEdge>>(
  Object.entries(edgeSchemas),
)

/** Unknown and inherited tag names cannot select a validator outside the exhaustive own-key tables. */
function variant(
  value: unknown,
  tag: unknown,
  checks: ReadonlyMap<unknown, Guard<unknown>>,
): boolean {
  const check = checks.get(tag)
  return check ? check(value) : false
}

/** Unused optional timestamp metadata follows the established field-repair policy, keeping the node intact. */
function repairOptionalMetadata(value: unknown, warnings: string[]): void {
  if (
    !isPlainObject(value) ||
    !isPlainObject(value.data) ||
    !isPlainObject(value.data.meta)
  )
    return
  const meta = value.data.meta
  for (const key of ['createdAt', 'updatedAt'] as const) {
    if (owns(meta, key) && !text(meta[key])) {
      delete meta[key]
      warnings.push(
        `[NORMALIZED_NODE_OPTIONAL_REPAIRED] 节点 ${String(value.id)} 的 meta.${key} 非字符串，已剥离`,
      )
    }
  }
}

/** Both member families share one stable diagnostic, retaining an available identity for recovery. */
function rejectShape(kind: 'node' | 'edge', value: unknown): never {
  const id = isPlainObject(value) ? String(value.id) : '?'
  throw new Error(`[NORMALIZED_GRAPH_SHAPE_INVALID] ${kind} ${id}`)
}

/** Finalize optional metadata, then reject an incomplete normalized result before session delivery or writeback. */
export function finalizeNormalizedGraph(
  graph: { nodes: readonly unknown[]; edges: readonly unknown[] },
  warnings: string[],
): void {
  for (const value of graph.nodes) {
    repairOptionalMetadata(value, warnings)
    if (!isPlainObject(value) || !variant(value, value.type, nodeChecks)) {
      rejectShape('node', value)
    }
  }
  for (const value of graph.edges) {
    if (
      !isPlainObject(value) ||
      !isPlainObject(value.data) ||
      !variant(value, value.data.kind, edgeChecks)
    ) {
      rejectShape('edge', value)
    }
  }
}
