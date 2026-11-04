// @vitest-environment happy-dom
/** #931：web/native 入口驱动真实文档及执行边界，只有设置加载是外部替身。 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AiThread } from './AiThread'
import { stubElementScrollTo } from './testDomStubs'
import { settingsStore } from '../../settings/settingsStore'
import {
  useEditorDocument,
  type EditorProjectContent,
} from '../useEditorDocument'
import { useNodePatch } from '../useNodePatch'
import { useAiBridge } from '../useAiBridge'
import { buildCanvasNode } from '../nodeFactory'
import { CommandStack } from '../history'
import { validateAiBatch } from '../ai/batchFold'
import type { AiCommand } from '../ai/commands'
import { branchOptionHandle } from '../graphRules'
import { normalizeAiSession, type AiSession } from '../../ai/session'

const host = window as Window & {
  __pwNativeHost?: unknown
  webkit?: unknown
  __pwNativeIntent?: (request: unknown) => Promise<unknown>
}
let requestId = 0

beforeEach(() => {
  stubElementScrollTo()
  vi.spyOn(settingsStore, 'load').mockResolvedValue({
    providers: [],
    defaultChat: null,
    defaultImage: null,
  })
})
afterEach(() => {
  cleanup()
  delete host.__pwNativeHost
  delete host.webkit
  vi.restoreAllMocks()
})

/** 单节拍关联一个场景，另有游离对白；可配置场景当前集号及共享节拍。 */
function project(episodeNo?: number, shared = false): EditorProjectContent {
  const b = {
    ...buildCanvasNode(
      'beat',
      { data: { name: '开端' } },
      { against: [], characters: [], center: null },
    ),
    id: 'b',
  }
  const s = {
    ...buildCanvasNode(
      'scene',
      {
        data: {
          name: '天台',
          ...(episodeNo === undefined ? {} : { episodeNo }),
        },
      },
      { against: [], characters: [], center: null },
    ),
    id: 's',
  }
  const loose = {
    ...buildCanvasNode('dialogue', undefined, {
      against: [],
      characters: [],
      center: null,
    }),
    id: 'loose',
  }
  const result: EditorProjectContent = {
    id: '931-ui',
    name: '分集',
    nodes: [b, s, loose],
    edges: [{ id: 'bs', source: 'b', target: 's' }],
    settings: { characters: [], locations: [] },
  }
  if (shared) {
    result.nodes.push({
      ...buildCanvasNode(
        'beat',
        { data: { name: '另一集', episodeNo: 2 } },
        { against: [], characters: [], center: null },
      ),
      id: 'other',
    })
    result.edges.push({ id: 'shared', source: 'other', target: 's' })
  }
  return result
}

/** 旧卡只保存模型命令，不预先携带归集结果或确认。 */
function legacySession(
  initial: EditorProjectContent,
  commands: AiCommand[],
): AiSession {
  const v = validateAiBatch(commands, {
    nodes: initial.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      label: n.id,
      ...(n.type === 'branch' ? { options: n.data.options } : {}),
    })),
    edges: initial.edges,
    assets: new Map(),
  })
  return {
    schemaVersion: 1,
    entries: [
      {
        id: 1,
        kind: 'msg',
        role: 'user',
        text: '为现有的节奏卡安排合适的分集',
      },
      {
        id: 2,
        kind: 'msg',
        role: 'assistant',
        text: '分集方案',
        card: { status: 'pending', v },
      },
    ],
  }
}

/** 恢复一张旧卡，不带关联元数据；使用当前 bridge 重建完整预览。 */
async function setup(
  initial = project(),
  native = false,
  commands: AiCommand[] = [
    { op: 'update_node', nodeId: 'b', patch: { episodeNo: 1 } },
  ],
) {
  if (native) {
    host.__pwNativeHost = {
      kind: 'swift',
      protocolVersion: 1,
      sessionId: '931-page',
    }
    host.webkit = { messageHandlers: { canvasHost: { postMessage: vi.fn() } } }
  }
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
  const session = legacySession(initial, commands)
  const saved: AiSession[] = []
  const props = () => ({
    projectId: initial.id,
    initialSession: session,
    canvasDigest: hook.result.current.ai.canvasDigest,
    onValidateCommands: hook.result.current.ai.validateCommands,
    onApplyAiBatch: hook.result.current.ai.applyAiBatch,
    onSaveSession: async (value: AiSession) => {
      saved.push(normalizeAiSession(JSON.parse(JSON.stringify(value))).session)
    },
  })
  const view = render(<AiThread {...props()} />)
  if (native)
    await waitFor(() => expect(host.__pwNativeIntent).toBeTypeOf('function'))
  else await screen.findByLabelText('AI 对话输入')
  return {
    hook,
    history,
    saved,
    refresh: () => view.rerender(<AiThread {...props()} />),
  }
}

/** 原生命令仍经生产 intent owner，不能直接绕过武装约束。 */
async function native(command: string) {
  let result: unknown
  await act(async () => {
    result = await host.__pwNativeIntent?.({
      protocolVersion: 1,
      sessionId: '931-page',
      requestId: String(++requestId),
      command,
      args: { projectId: '931-ui', entryId: 2 },
    })
  })
  return result
}

it('旧卡恢复展示全部关联改动，普通确认后一次撤销恢复两侧', async () => {
  const h = await setup()
  expect(screen.getByText('✦ 改动预览 · 2 项')).toBeTruthy()
  expect(screen.getByText(/天台.*未分集 → 第 1 集/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '✓ 执行改动' }))
  expect(
    h.hook.result.current.doc.nodes.find((n) => n.id === 's')?.data.episodeNo,
  ).toBe(1)
  act(() => h.history.undo())
  expect(
    h.hook.result.current.doc.nodes.every(
      (n) => n.data.episodeNo === undefined,
    ),
  ).toBe(true)
  expect(h.history.canUndo).toBe(false)
})

it('冲突第一次点击不执行，明确确认后才覆盖原归属', async () => {
  const h = await setup(project(9))
  expect(screen.getByRole('alert').textContent).toContain('第 9 集 → 第 1 集')
  fireEvent.click(screen.getByRole('button', { name: '确认分集冲突…' }))
  expect(
    h.hook.result.current.doc.nodes.find((n) => n.id === 's')?.data.episodeNo,
  ).toBe(9)
  expect(h.history.canUndo).toBe(false)
  fireEvent.click(
    screen.getByRole('button', { name: '确认本次分集冲突并执行' }),
  )
  expect(
    h.hook.result.current.doc.nodes.find((n) => n.id === 's')?.data.episodeNo,
  ).toBe(1)
  expect(screen.queryByRole('alert')).toBeNull()
})

it('冲突可以取消，已武装也不会写图或留下跨卡确认', async () => {
  const h = await setup(project(9))
  fireEvent.click(screen.getByRole('button', { name: '确认分集冲突…' }))
  fireEvent.click(screen.getByRole('button', { name: '忽略' }))
  expect(screen.queryByLabelText('AI 改动预览')).toBeNull()
  expect(
    h.hook.result.current.doc.nodes.find((n) => n.id === 's')?.data.episodeNo,
  ).toBe(9)
  expect(h.history.canUndo).toBe(false)
})

it('图变化使已武装确认失效，本次零写入并展示更新后的全部改动', async () => {
  const h = await setup(project(9))
  fireEvent.click(screen.getByRole('button', { name: '确认分集冲突…' }))
  act(() =>
    h.hook.result.current.doc.setEdges((edges) => [
      ...edges,
      { id: 'new', source: 's', target: 'loose' },
    ]),
  )
  h.refresh()
  fireEvent.click(
    screen.getByRole('button', { name: '确认本次分集冲突并执行' }),
  )
  expect(screen.getByText(/分集关联预览已更新/)).toBeTruthy()
  expect(screen.getByText('✦ 改动预览 · 3 项')).toBeTruthy()
  expect(screen.getByRole('button', { name: '确认分集冲突…' })).toBeTruthy()
  expect(h.history.canUndo).toBe(false)
  expect(
    h.hook.result.current.doc.nodes.find((n) => n.id === 'b')?.data.episodeNo,
  ).toBeUndefined()
})

it('跨集共享提示两个目标，确认后保留共享节点原归属', async () => {
  const h = await setup(project(undefined, true))
  expect(screen.getByRole('alert').textContent).toContain('开端 → 第 1 集')
  expect(screen.getByRole('alert').textContent).toContain('另一集 → 第 2 集')
  fireEvent.click(screen.getByRole('button', { name: '确认分集冲突…' }))
  fireEvent.click(
    screen.getByRole('button', { name: '确认本次分集冲突并执行' }),
  )
  expect(
    h.hook.result.current.doc.nodes.find((n) => n.id === 's')?.data.episodeNo,
  ).toBeUndefined()
  expect(
    h.hook.result.current.doc.nodes.find((n) => n.id === 'b')?.data.episodeNo,
  ).toBe(1)
})

it('原生入口直接 execute 被拒绝，arm 后才可确认冲突；不会因聊天授权自动通过', async () => {
  const h = await setup(project(9), true)
  expect(await native('ai.execute')).toMatchObject({
    error: { code: 'PW_INTENT_FAILED' },
  })
  expect(h.history.canUndo).toBe(false)
  expect(await native('ai.arm')).toEqual({ ok: null })
  expect(h.history.canUndo).toBe(false)
  expect(await native('ai.execute')).toEqual({ ok: null })
  expect(
    h.hook.result.current.doc.nodes.find((n) => n.id === 's')?.data.episodeNo,
  ).toBe(1)
})

it('原生已武装后关联变化不会复用确认，并保留未执行的原始数据', async () => {
  const h = await setup(project(9), true)
  await native('ai.arm')
  act(() =>
    h.hook.result.current.doc.setEdges((edges) => [
      ...edges,
      { id: 'new', source: 's', target: 'loose' },
    ]),
  )
  h.refresh()
  await native('ai.execute')
  expect(h.history.canUndo).toBe(false)
  expect(
    h.hook.result.current.doc.nodes.find((n) => n.id === 's')?.data.episodeNo,
  ).toBe(9)
  expect(await native('ai.execute')).toMatchObject({
    error: { code: 'PW_INTENT_FAILED' },
  })
})

it('分集与删选项同批时，新增隐式断边会更新预览并撤销旧删除确认', async () => {
  const initial = project()
  const r = {
    ...buildCanvasNode('branch', undefined, {
      against: [],
      characters: [],
      center: null,
    }),
    id: 'r',
  }
  if (r.type !== 'branch') throw new Error('fixture')
  const [drop, keep] = r.data.options
  if (!drop || !keep) throw new Error('fixture')
  initial.nodes.push(r)
  initial.edges = [
    { id: 'br', source: 'b', target: 'r' },
    {
      id: 'rs',
      source: 'r',
      target: 's',
      type: 'branch',
      sourceHandle: branchOptionHandle(drop.id),
    },
    {
      id: 'rd',
      source: 'r',
      target: 'loose',
      type: 'branch',
      sourceHandle: branchOptionHandle(keep.id),
    },
  ]
  const h = await setup(initial, false, [
    { op: 'update_node', nodeId: 'b', patch: { episodeNo: 1 } },
    { op: 'update_node', nodeId: 'r', patch: { options: [keep] } },
  ])
  fireEvent.click(screen.getByRole('button', { name: '执行（含 1 项删除）' }))
  act(() =>
    h.hook.result.current.doc.setEdges((edges) => [
      ...edges,
      {
        id: 'new-danger',
        source: 'r',
        target: 'loose',
        type: 'branch',
        sourceHandle: branchOptionHandle(drop.id),
      },
    ]),
  )
  h.refresh()
  fireEvent.click(screen.getByRole('button', { name: '再点一次确认执行删除' }))
  expect(screen.getByText(/分集关联预览已更新/)).toBeTruthy()
  expect(
    screen.getByRole('button', { name: '执行（含 2 项删除）' }),
  ).toBeTruthy()
  expect(h.history.canUndo).toBe(false)
  expect(
    h.hook.result.current.doc.edges.some((e) => e.id === 'new-danger'),
  ).toBe(true)
})
