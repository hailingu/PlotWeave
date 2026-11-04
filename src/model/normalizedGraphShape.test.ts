/** Complete known-field validation and retained repair semantics at the final graph boundary (#946). */
import { expect, it } from 'vitest'
import { parseProject, serializeProject } from './convert'
import { mkContent, NOW } from './convertFixtures'
import type { ProjectDocument } from './document'
import { finalizeNormalizedGraph } from './normalizedGraphShape'

type Graph = ProjectDocument['graph']

/** Own all six node variants and all three edge variants without any external storage or services. */
function graphFixture(): Graph {
  const graph = serializeProject(mkContent(), 'p-1', NOW).graph
  graph.nodes.push({
    id: 'im1',
    type: 'image',
    layout: { position: { x: 1, y: 2 } },
    ui: { selected: false, expanded: true },
    data: {
      meta: {},
      spec: {
        prompt: '画面',
        model: 'fixture:image',
        size: '1x1',
        outputs: { primary: { assetId: 'a-1', width: 1, height: 2 } },
      },
    },
  })
  return graph
}

/** Raw mutations deliberately simulate missed input checks; they are not typed domain construction. */
function raw(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>
}

/** Resolve a required owned node before corrupting its shape. */
function node(graph: Graph, id = 's1'): Record<string, unknown> {
  const found = graph.nodes.find((value) => value.id === id)
  if (!found) throw new Error('Expected the owned node fixture')
  return raw(found)
}

/** Nested node sections keep each mutation focused on its actual domain field. */
function spec(graph: Graph, id = 's1') {
  return raw(raw(node(graph, id).data).spec)
}
/** Mutate metadata independently of the node's specification fields. */
function meta(graph: Graph, id = 's1') {
  return raw(raw(node(graph, id).data).meta)
}
/** Keep layout corruption separate from semantic node data. */
function layout(graph: Graph) {
  return raw(node(graph).layout)
}
/** Select a dialogue member whose required and optional fields are under test. */
function line(graph: Graph) {
  return raw((spec(graph, 'd1').lines as unknown[])[0])
}
/** Select a shot reference without changing the enclosing list shape. */
function ref(graph: Graph) {
  return raw((spec(graph, 'sh1').refs as unknown[])[0])
}

/** Resolve an owned edge variant so mutations do not depend on fixture ordering. */
function edge(
  graph: Graph,
  kind: 'sequence' | 'branch' | 'attach' = 'sequence',
) {
  const found = graph.edges.find((value) => value.data.kind === kind)
  if (!found) throw new Error('Expected the owned edge fixture')
  return raw(found)
}

const nodeCases: [string, (graph: Graph) => void][] = [
  [
    'missing id',
    (g) => {
      delete node(g).id
    },
  ],
  [
    'non-string id',
    (g) => {
      node(g).id = 3
    },
  ],
  [
    'unknown tag',
    (g) => {
      node(g).type = 'unknown'
    },
  ],
  [
    'inherited tag',
    (g) => {
      node(g).type = 'constructor'
    },
  ],
  [
    'missing layout',
    (g) => {
      delete node(g).layout
    },
  ],
  [
    'bad position x',
    (g) => {
      layout(g).position = { x: Infinity, y: 0 }
    },
  ],
  [
    'missing position y',
    (g) => {
      layout(g).position = { x: 0 }
    },
  ],
  [
    'bad size width',
    (g) => {
      layout(g).size = { width: 0, height: 1 }
    },
  ],
  [
    'bad size height',
    (g) => {
      layout(g).size = { width: 1, height: '1' }
    },
  ],
  [
    'bad zIndex',
    (g) => {
      layout(g).zIndex = NaN
    },
  ],
  [
    'missing ui',
    (g) => {
      delete node(g).ui
    },
  ],
  [
    'bad selected',
    (g) => {
      node(g).ui = { selected: 'false', expanded: true }
    },
  ],
  [
    'missing expanded',
    (g) => {
      node(g).ui = { selected: false }
    },
  ],
  [
    'missing data',
    (g) => {
      delete node(g).data
    },
  ],
  [
    'missing meta',
    (g) => {
      delete raw(node(g).data).meta
    },
  ],
  [
    'missing label',
    (g) => {
      delete meta(g).label
    },
  ],
  [
    'bad episode',
    (g) => {
      meta(g).episodeNo = 0
    },
  ],
  [
    'fractional episode',
    (g) => {
      meta(g).episodeNo = 1.5
    },
  ],
  [
    'forbidden branch label',
    (g) => {
      meta(g, 'br1').label = 'mirror'
    },
  ],
  [
    'forbidden shot episode',
    (g) => {
      meta(g, 'sh1').episodeNo = 1
    },
  ],
  [
    'forbidden image label',
    (g) => {
      meta(g, 'im1').label = 'mirror'
    },
  ],
  [
    'bad sceneNo',
    (g) => {
      spec(g).sceneNo = Number.MAX_SAFE_INTEGER + 1
    },
  ],
  [
    'bad interior',
    (g) => {
      spec(g).interior = 1
    },
  ],
  [
    'bad synopsis',
    (g) => {
      spec(g).synopsis = {}
    },
  ],
  [
    'bad characterIds container',
    (g) => {
      spec(g).characterIds = {}
    },
  ],
  [
    'bad characterIds member',
    (g) => {
      spec(g).characterIds = [1]
    },
  ],
  [
    'bad optional location',
    (g) => {
      spec(g).locationId = null
    },
  ],
  [
    'bad optional time',
    (g) => {
      spec(g).time = {}
    },
  ],
  [
    'bad optional weather',
    (g) => {
      spec(g).weather = 3
    },
  ],
  [
    'bad tone',
    (g) => {
      spec(g, 'b1').tone = {}
    },
  ],
  [
    'bad lines container',
    (g) => {
      spec(g, 'd1').lines = {}
    },
  ],
  [
    'bad line id',
    (g) => {
      delete line(g).id
    },
  ],
  [
    'bad line kind',
    (g) => {
      line(g).kind = 'narration'
    },
  ],
  [
    'array line kind is not a literal',
    (g) => {
      line(g).kind = ['line']
    },
  ],
  [
    'bad line text',
    (g) => {
      line(g).text = {}
    },
  ],
  [
    'bad speaker',
    (g) => {
      line(g).speaker = {}
    },
  ],
  [
    'bad side',
    (g) => {
      line(g).side = 'up'
    },
  ],
  [
    'array side is not a literal',
    (g) => {
      line(g).side = ['left']
    },
  ],
  [
    'bad vo',
    (g) => {
      line(g).vo = 'false'
    },
  ],
  [
    'bad branch prompt',
    (g) => {
      spec(g, 'br1').prompt = {}
    },
  ],
  [
    'bad option label',
    (g) => {
      raw((spec(g, 'br1').options as unknown[])[0]).label = {}
    },
  ],
  [
    'bad option id',
    (g) => {
      delete raw((spec(g, 'br1').options as unknown[])[0]).id
    },
  ],
  [
    'missing shotNo',
    (g) => {
      delete spec(g, 'sh1').shotNo
    },
  ],
  [
    'bad shot size',
    (g) => {
      spec(g, 'sh1').size = {}
    },
  ],
  [
    'bad shot picture',
    (g) => {
      spec(g, 'sh1').picture = {}
    },
  ],
  [
    'bad shot prompt',
    (g) => {
      spec(g, 'sh1').prompt = {}
    },
  ],
  [
    'bad refs container',
    (g) => {
      spec(g, 'sh1').refs = {}
    },
  ],
  [
    'bad ref kind',
    (g) => {
      ref(g).kind = 'other'
    },
  ],
  [
    'array ref kind is not a literal',
    (g) => {
      ref(g).kind = ['character']
    },
  ],
  [
    'bad ref id',
    (g) => {
      delete ref(g).id
    },
  ],
  [
    'both ref arms',
    (g) => {
      ref(g).assetId = 'a-1'
      ref(g).label = 'mirror'
    },
  ],
  [
    'neither ref arm',
    (g) => {
      delete ref(g).assetId
      delete ref(g).label
    },
  ],
  [
    'bad image prompt',
    (g) => {
      spec(g, 'im1').prompt = {}
    },
  ],
  [
    'bad image model',
    (g) => {
      spec(g, 'im1').model = {}
    },
  ],
  [
    'bad image size',
    (g) => {
      spec(g, 'im1').size = {}
    },
  ],
  [
    'bad outputs container',
    (g) => {
      spec(g, 'im1').outputs = null
    },
  ],
  [
    'bad output asset',
    (g) => {
      spec(g, 'im1').outputs = { primary: { assetId: 1 } }
    },
  ],
  [
    'bad output width',
    (g) => {
      spec(g, 'im1').outputs = { primary: { assetId: 'a-1', width: 0 } }
    },
  ],
  [
    'bad output height',
    (g) => {
      spec(g, 'im1').outputs = { primary: { assetId: 'a-1', height: Infinity } }
    },
  ],
]

const edgeCases: [string, (graph: Graph) => void][] = [
  [
    'missing id',
    (g) => {
      delete edge(g).id
    },
  ],
  [
    'non-string source',
    (g) => {
      edge(g).source = {}
    },
  ],
  [
    'missing target',
    (g) => {
      delete edge(g).target
    },
  ],
  [
    'missing data',
    (g) => {
      delete edge(g).data
    },
  ],
  [
    'unknown kind',
    (g) => {
      raw(edge(g).data).kind = 'unknown'
    },
  ],
  [
    'inherited kind',
    (g) => {
      raw(edge(g).data).kind = '__proto__'
    },
  ],
  [
    'non-string kind',
    (g) => {
      raw(edge(g).data).kind = 1
    },
  ],
  [
    'bad order',
    (g) => {
      raw(edge(g).data).order = Infinity
    },
  ],
  [
    'forbidden targetHandle',
    (g) => {
      edge(g).targetHandle = 'mirror'
    },
  ],
  [
    'forbidden sequence sourceHandle',
    (g) => {
      edge(g).sourceHandle = 'mirror'
    },
  ],
  [
    'forbidden explicit undefined',
    (g) => {
      edge(g).sourceHandle = undefined
    },
  ],
  [
    'missing branch handle',
    (g) => {
      delete edge(g, 'branch').sourceHandle
    },
  ],
  [
    'bad branch handle',
    (g) => {
      edge(g, 'branch').sourceHandle = 1
    },
  ],
  [
    'wrong attach handle',
    (g) => {
      edge(g, 'attach').sourceHandle = 'other'
    },
  ],
]

it.each([null, undefined, true, 1, 'document'])(
  'rejects a non-object root with the owned diagnostic: %j',
  (value) => {
    expect(() => parseProject(value)).toThrow(
      new TypeError('项目文件损坏：不是有效的文档对象'),
    )
  },
)

it('accepts all variants, optional fields, empty lists and retained extensions without changing valid input', () => {
  const graph = graphFixture()
  meta(graph).createdAt = 'kept'
  meta(graph).updatedAt = 'kept-too'
  spec(graph).futureExtension = { retained: true }
  const lines = spec(graph, 'd1').lines as unknown[]
  lines.push({
    id: 'action',
    kind: 'action',
    text: '',
    speaker: null,
    side: 'right',
    vo: true,
  })
  lines.push({
    id: 'left',
    kind: 'line',
    text: '',
    speaker: '',
    side: 'left',
  })
  const refs = spec(graph, 'sh1').refs as unknown[]
  refs.push(
    { id: 'free', kind: 'location', label: '' },
    { id: 'audio', kind: 'audio', assetId: 'a-1' },
  )
  const before = structuredClone(graph)
  const warnings: string[] = []
  expect(() => finalizeNormalizedGraph(graph, warnings)).not.toThrow()
  expect(graph).toEqual(before)
  expect(warnings).toEqual([])
  expect(() =>
    finalizeNormalizedGraph({ nodes: [], edges: [] }, []),
  ).not.toThrow()
})

it.each(nodeCases)('rejects missed node shape: %s', (_name, corrupt) => {
  const graph = graphFixture()
  corrupt(graph)
  expect(() => finalizeNormalizedGraph(graph, [])).toThrow(
    '[NORMALIZED_GRAPH_SHAPE_INVALID] node',
  )
})

it.each(edgeCases)('rejects missed edge shape: %s', (_name, corrupt) => {
  const graph = graphFixture()
  corrupt(graph)
  expect(() => finalizeNormalizedGraph(graph, [])).toThrow(
    '[NORMALIZED_GRAPH_SHAPE_INVALID] edge',
  )
})

it('repairs only malformed optional timestamps, preserving nodes, edges and idempotence', () => {
  const graph = graphFixture()
  meta(graph).createdAt = {}
  meta(graph).updatedAt = null
  const ids = graph.nodes.map((value) => value.id)
  const edges = structuredClone(graph.edges)
  const warnings: string[] = []
  finalizeNormalizedGraph(graph, warnings)
  expect(meta(graph)).not.toHaveProperty('createdAt')
  expect(meta(graph)).not.toHaveProperty('updatedAt')
  expect(graph.nodes.map((value) => value.id)).toEqual(ids)
  expect(graph.edges).toEqual(edges)
  expect(warnings).toHaveLength(2)
  expect(
    warnings.every((warning) =>
      warning.startsWith('[NORMALIZED_NODE_OPTIONAL_REPAIRED]'),
    ),
  ).toBe(true)
  finalizeNormalizedGraph(graph, warnings)
  expect(warnings).toHaveLength(2)
})

it('surfaces optional metadata repair through parseProject and converges after serialization', () => {
  const document = serializeProject(mkContent(), 'p-1', NOW)
  meta(document.graph).createdAt = { dirty: true }
  meta(document.graph).updatedAt = null
  const loaded = parseProject(document)
  expect(loaded.repaired).toBe(true)
  expect(loaded.content.nodes.map((value) => value.id)).toEqual(
    mkContent().nodes.map((value) => value.id),
  )
  expect(
    loaded.warnings.filter((value) =>
      value.startsWith('[NORMALIZED_NODE_OPTIONAL_REPAIRED]'),
    ),
  ).toHaveLength(2)
  const clean = parseProject(serializeProject(loaded.content, 'p-1', NOW))
  expect(clean.repaired).toBe(false)
  expect(clean.warnings).toEqual([])
})

it.each([null, [], 'node'])(
  'rejects an injected non-object node: %j',
  (value) => {
    expect(() =>
      finalizeNormalizedGraph({ nodes: [value], edges: [] }, []),
    ).toThrow('[NORMALIZED_GRAPH_SHAPE_INVALID] node ?')
  },
)
it.each([null, [], { id: 'bad', data: null }])(
  'rejects an injected non-object edge: %j',
  (value) => {
    expect(() =>
      finalizeNormalizedGraph({ nodes: [], edges: [value] }, []),
    ).toThrow('[NORMALIZED_GRAPH_SHAPE_INVALID] edge')
  },
)
