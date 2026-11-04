// @vitest-environment happy-dom
/** #931：真实文档、批次执行、历史和持久格式的归集回归。 */
import { afterEach, expect, it } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import {
  useEditorDocument,
  type EditorProjectContent,
} from './useEditorDocument'
import { useNodePatch } from './useNodePatch'
import { useAiBridge } from './useAiBridge'
import { CommandStack } from './history'
import { buildCanvasNode } from './nodeFactory'
import { buildOutlineGroups } from './outline'
import { parseProject, serializeProject } from '../model/convert'
import type { AiCommand } from './ai/commands'
import { branchOptionHandle } from './graphRules'

afterEach(cleanup)

/** 两条互相相连的节拍链，第三个节点保持游离。 */
function project(): EditorProjectContent {
  const make = (
    type: 'beat' | 'scene' | 'dialogue' | 'branch',
    id: string,
  ) => ({
    ...buildCanvasNode(type, undefined, {
      against: [],
      characters: [],
      center: null,
    }),
    id,
  })
  const branch = make('branch', 'r')
  if (branch.type !== 'branch') throw new Error('fixture')
  return {
    id: '931-fixture',
    name: '分集',
    settings: { characters: [], locations: [] },
    nodes: [
      make('beat', 'a'),
      make('scene', 's'),
      make('dialogue', 'd'),
      branch,
      make('beat', 'b'),
      make('scene', 't'),
      make('dialogue', 'loose'),
    ],
    edges: [
      { id: 'as', source: 'a', target: 's' },
      { id: 'sd', source: 's', target: 'd' },
      { id: 'dr', source: 'd', target: 'r' },
      {
        id: 'next',
        source: 'r',
        target: 'b',
        type: 'branch',
        sourceHandle: branchOptionHandle(branch.data.options[0]!.id),
      },
      { id: 'bt', source: 'b', target: 't' },
    ],
  }
}

/** 与 EditorView 相同的文档与写入所有者；不替换业务方法。 */
function setup(initial = project()) {
  const history = new CommandStack()
  const hook = renderHook(() => {
    const doc = useEditorDocument(initial)
    const patch = useNodePatch(doc, (command) => history.push(command))
    const ai = useAiBridge({
      ...doc,
      ...patch,
      buildNewNode: (type, opts) =>
        buildCanvasNode(type, opts, {
          against: opts?.against ?? doc.nodesRef.current,
          characters: [],
          center: null,
        }),
      pushHistory: (command) => history.push(command),
      closeSettings: () => undefined,
    })
    return { doc, ai }
  })
  return { hook, history }
}

/** 按稳定身份输出集号，不依赖大纲来猜实际数据。 */
function episodes(doc: EditorProjectContent['nodes']) {
  return Object.fromEntries(doc.map((n) => [n.id, n.data.episodeNo ?? null]))
}

const assign: AiCommand[] = [
  { op: 'update_node', nodeId: 'a', patch: { episodeNo: 1 } },
  { op: 'update_node', nodeId: 'b', patch: { episodeNo: 2 } },
]

it('两集预览列出全部关联更新，执行、保存重载及整批撤销重做一致', async () => {
  const h = setup()
  const preview = h.hook.result.current.ai.validateCommands(assign)!
  expect(preview.ok).toBe(true)
  expect(preview.items).toHaveLength(6)
  const fingerprint = preview.episodeAssignment?.fingerprint
  expect(fingerprint).toBeTruthy()
  const edges = h.hook.result.current.doc.edges
  act(() =>
    expect(
      h.hook.result.current.ai.applyAiBatch(preview.commands, {
        episodeFingerprint: fingerprint,
      }),
    ).toBeNull(),
  )
  const expected = { a: 1, s: 1, d: 1, r: 1, b: 2, t: 2, loose: null }
  expect(episodes(h.hook.result.current.doc.nodes)).toEqual(expected)
  expect(h.hook.result.current.doc.edges).toEqual(edges)
  expect(
    buildOutlineGroups(h.hook.result.current.doc.nodes, edges, {}).map(
      (group) => group.episode,
    ),
  ).toEqual([1, 2, null])
  const parsed = parseProject(
    JSON.parse(
      JSON.stringify(
        serializeProject(
          { ...h.hook.result.current.doc, name: '分集' },
          '931-fixture',
        ),
      ),
    ),
    { projectId: '931-fixture' },
  )
  expect(episodes(parsed.content.nodes)).toEqual(expected)
  act(() => h.history.undo())
  expect(Object.values(episodes(h.hook.result.current.doc.nodes))).toEqual(
    Array(7).fill(null),
  )
  expect(h.history.canUndo).toBe(false)
  await act(() => h.history.redo())
  expect(episodes(h.hook.result.current.doc.nodes)).toEqual(expected)
  const repeated = h.hook.result.current.ai.validateCommands(assign)!
  act(() =>
    expect(
      h.hook.result.current.ai.applyAiBatch(repeated.commands, {
        episodeFingerprint: repeated.episodeAssignment?.fingerprint,
      }),
    ).toBeNull(),
  )
  expect(episodes(h.hook.result.current.doc.nodes)).toEqual(expected)
})

it('已有其他集归属阻断整批，只有本计划明确确认才可覆盖', () => {
  const initial = project()
  initial.nodes = initial.nodes.map((n) =>
    n.id === 's' && n.type === 'scene'
      ? { ...n, data: { ...n.data, episodeNo: 9 } }
      : n,
  )
  const h = setup(initial)
  const preview = h.hook.result.current.ai.validateCommands(assign)!
  expect(preview.episodeAssignment?.conflicts.join()).toContain(
    '第 9 集 → 第 1 集',
  )
  const options = { episodeFingerprint: preview.episodeAssignment?.fingerprint }
  act(() =>
    expect(
      h.hook.result.current.ai.applyAiBatch(preview.commands, options),
    ).toContain('冲突'),
  )
  expect(episodes(h.hook.result.current.doc.nodes)).toEqual(
    episodes(initial.nodes),
  )
  expect(h.history.canUndo).toBe(false)
  act(() =>
    expect(
      h.hook.result.current.ai.applyAiBatch(preview.commands, {
        ...options,
        episodeConflicts: true,
      }),
    ).toBeNull(),
  )
  expect(episodes(h.hook.result.current.doc.nodes).s).toBe(1)
})

it('不同集节拍共享对白保留原归属，确认前整批零写入，确认后只执行已列改动', () => {
  const initial = project()
  initial.edges.push({ id: 'share', source: 't', target: 'd' })
  const h = setup(initial)
  const preview = h.hook.result.current.ai.validateCommands(assign)!
  expect(preview.episodeAssignment?.conflicts.join()).toContain('保留原归属')
  const options = { episodeFingerprint: preview.episodeAssignment?.fingerprint }
  expect(
    h.hook.result.current.ai.applyAiBatch(preview.commands, options),
  ).toContain('冲突')
  expect(episodes(h.hook.result.current.doc.nodes)).toEqual(
    episodes(initial.nodes),
  )
  act(() =>
    expect(
      h.hook.result.current.ai.applyAiBatch(preview.commands, {
        ...options,
        episodeConflicts: true,
      }),
    ).toBeNull(),
  )
  expect(episodes(h.hook.result.current.doc.nodes)).toMatchObject({
    a: 1,
    s: 1,
    d: null,
    r: null,
    b: 2,
    t: 2,
    loose: null,
  })
})

it('改图后旧确认失效，即使携带冲突确认也不能执行新计划', () => {
  const h = setup()
  const preview = h.hook.result.current.ai.validateCommands(assign)!
  act(() =>
    h.hook.result.current.doc.setEdges((edges) => [
      ...edges,
      { id: 'new-link', source: 's', target: 'loose' },
    ]),
  )
  expect(
    h.hook.result.current.ai.applyAiBatch(preview.commands, {
      episodeFingerprint: preview.episodeAssignment?.fingerprint,
      episodeConflicts: true,
    }),
  ).toContain('已变化')
  expect(Object.values(episodes(h.hook.result.current.doc.nodes))).toEqual(
    Array(7).fill(null),
  )
  expect(h.history.canUndo).toBe(false)
})

it('分集同时删选项时，预览后新增的级联断边也使旧签名失效', () => {
  const initial = project()
  const r = initial.nodes.find((n) => n.id === 'r')
  if (r?.type !== 'branch') throw new Error('fixture')
  const [drop, keep] = r.data.options
  if (!drop || !keep) throw new Error('fixture')
  initial.edges = [
    { id: 'ar', source: 'a', target: 'r' },
    {
      id: 'rs',
      source: 'r',
      target: 's',
      type: 'branch',
      sourceHandle: branchOptionHandle(drop.id),
    },
    {
      id: 'rt',
      source: 'r',
      target: 't',
      type: 'branch',
      sourceHandle: branchOptionHandle(keep.id),
    },
  ]
  const h = setup(initial)
  const preview = h.hook.result.current.ai.validateCommands([
    assign[0]!,
    { op: 'update_node', nodeId: 'r', patch: { options: [keep] } },
  ])!
  expect(preview.hasDeletes).toBe(true)
  act(() =>
    h.hook.result.current.doc.setEdges((edges) => [
      ...edges,
      {
        id: 'new-danger',
        source: 'r',
        target: 't',
        type: 'branch',
        sourceHandle: branchOptionHandle(drop.id),
      },
    ]),
  )
  expect(
    h.hook.result.current.ai.applyAiBatch(preview.commands, {
      episodeFingerprint: preview.episodeAssignment?.fingerprint,
      episodeConflicts: true,
    }),
  ).toContain('已变化')
  expect(h.history.canUndo).toBe(false)
})

it('其他集场景入向共享时整批阻断，确认后保留共享原归属且不移动入向节点', () => {
  const initial = project()
  initial.nodes = initial.nodes.map((n) => {
    if (n.type === 'beat' && n.id === 'a')
      return { ...n, data: { ...n.data, episodeNo: 1 } }
    if (n.type === 'scene' && n.id === 's')
      return { ...n, data: { ...n.data, episodeNo: 1 } }
    return n
  })
  initial.nodes.push({
    ...buildCanvasNode(
      'scene',
      { data: { name: '他集入向', episodeNo: 3 } },
      { against: [], characters: [], center: null },
    ),
    id: 'external',
  })
  initial.edges.push({ id: 'external-s', source: 'external', target: 's' })
  const h = setup(initial)
  const v = h.hook.result.current.ai.validateCommands([
    { op: 'update_node', nodeId: 'a', patch: { episodeNo: 2 } },
  ])!
  expect(v.episodeAssignment?.conflicts.join()).toContain('他集入向')
  const confirmation = { episodeFingerprint: v.episodeAssignment?.fingerprint }
  expect(
    h.hook.result.current.ai.applyAiBatch(v.commands, confirmation),
  ).toContain('冲突')
  expect(h.history.canUndo).toBe(false)
  act(() =>
    expect(
      h.hook.result.current.ai.applyAiBatch(v.commands, {
        ...confirmation,
        episodeConflicts: true,
      }),
    ).toBeNull(),
  )
  expect(episodes(h.hook.result.current.doc.nodes)).toMatchObject({
    a: 2,
    s: 1,
    external: 3,
    d: null,
    r: null,
  })
})
