// @vitest-environment happy-dom
/** #929：真实文档、补丁、工厂、AI 面板、批次执行、历史与序列化共同运行。 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react'
import { AiThread } from './AiThread'
import { stubElementScrollTo } from './testDomStubs'
import { settingsStore } from '../../settings/settingsStore'
import { llmChat, type AssistantMessage } from '../ai/chat'
import {
  diskSessionOf,
  normalizeAiSession,
  type AiSession,
} from '../../ai/session'
import {
  useEditorDocument,
  type EditorDocument,
  type EditorProjectContent,
} from '../useEditorDocument'
import { useNodePatch } from '../useNodePatch'
import { useAiBridge } from '../useAiBridge'
import { buildCanvasNode } from '../nodeFactory'
import { CommandStack } from '../history'
import { parseProject, serializeProject } from '../../model/convert'
import { buildOutlineGroups } from '../outline'
import type { AiCommand } from '../ai/commands'
import type { CanvasNode } from '../nodes/types'

vi.mock('../ai/chat', () => ({ llmChat: vi.fn() }))
const chat = vi.mocked(llmChat)
const project: EditorProjectContent = {
  id: 'episode-project',
  name: '分集回归',
  settings: { characters: [], locations: [] },
  nodes: [
    {
      id: 'b',
      type: 'beat',
      position: { x: 0, y: 0 },
      data: { name: '开端', tone: '紧张', episodeNo: 1 },
    },
    {
      id: 's',
      type: 'scene',
      position: { x: 100, y: 0 },
      data: {
        name: '天台',
        sceneNo: 1,
        interior: false,
        time: '夜',
        synopsis: '',
        characterIds: [],
      },
    },
    {
      id: 'd',
      type: 'dialogue',
      position: { x: 200, y: 0 },
      data: { name: '争执', lines: [] },
    },
    {
      id: 'r',
      type: 'branch',
      position: { x: 300, y: 0 },
      data: { prompt: '留下？', options: [{ id: 'yes', label: '留下' }] },
    },
  ],
  edges: [
    { id: 'bs', source: 'b', target: 's', type: 'sequence' },
    { id: 'sd', source: 's', target: 'd', type: 'sequence' },
    { id: 'dr', source: 'd', target: 'r', type: 'sequence' },
  ],
}

beforeEach(() => {
  stubElementScrollTo()
  chat.mockReset()
  vi.spyOn(settingsStore, 'load').mockResolvedValue({
    providers: [
      {
        id: 'test',
        label: '测试',
        baseUrl: 'https://example.test/v1',
        enabled: true,
        models: ['m'],
        keyEnc: 'fixture',
      },
    ],
    defaultChat: 'test:m',
    defaultImage: null,
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** 供应商响应只有传输替换，命令解析/校验和画布落地保持真实。 */
function reply(commands: AiCommand[], fenced = false): AssistantMessage {
  const args = JSON.stringify({ commands })
  return fenced
    ? { role: 'assistant', content: `方案\n\`\`\`json\n${args}\n\`\`\`` }
    : {
        role: 'assistant',
        content: '方案',
        tool_calls: [
          {
            id: 'batch',
            type: 'function',
            function: { name: 'batch', arguments: args },
          },
        ],
      }
}

/** 以生产文档镜像和写通道装配，refresh 对应编辑器随文档变化重渲染。 */
async function setup(initialSession?: AiSession) {
  const history = new CommandStack()
  const hook = renderHook(() => {
    const doc = useEditorDocument(project)
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
    return { doc, patch, ai }
  })
  const saved: AiSession[] = []
  const props = () => ({
    projectId: project.id,
    initialSession,
    canvasDigest: hook.result.current.ai.canvasDigest,
    onValidateCommands: hook.result.current.ai.validateCommands,
    onValidateAi: hook.result.current.ai.validateAiReply,
    onReadNode: hook.result.current.ai.readNode,
    onApplyAiBatch: hook.result.current.ai.applyAiBatch,
    onSaveSession: async (session: AiSession) => {
      saved.push(
        normalizeAiSession(JSON.parse(JSON.stringify(session))).session,
      )
    },
  })
  const view = render(<AiThread {...props()} />)
  await screen.findByLabelText('AI 对话输入')
  const refresh = () => view.rerender(<AiThread {...props()} />)
  return { hook, history, saved, refresh }
}

/** 真实发送入口，等待模型回合落定再操作预览。 */
async function send(text: string) {
  fireEvent.change(screen.getByLabelText('AI 对话输入'), {
    target: { value: text },
  })
  fireEvent.click(screen.getByRole('button', { name: '发送' }))
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: '取消' })).toBeNull(),
  )
}

/** 分集归属取生产节点字段，包含节拍、场、对白和分支。 */
function episodes(nodes: CanvasNode[]) {
  return nodes.map((node) => node.data.episodeNo)
}

/** 生产序列化及加载后的归属和大纲必须一致，而非仅检查内存字段。 */
function expectUnassignedReload(doc: EditorDocument) {
  const stored = JSON.parse(
    JSON.stringify(
      serializeProject({ ...doc, name: project.name }, project.id),
    ),
  )
  const loaded = parseProject(stored, { projectId: project.id })
  expect(loaded.repaired).toBe(false)
  const reopened = loaded.content
  expect(episodes(reopened.nodes)).toEqual(Array(5).fill(undefined))
  expect(
    buildOutlineGroups(reopened.nodes, reopened.edges, {}).map(
      (group) => group.episode,
    ),
  ).toEqual([null])
}

it.each([
  [false, '根据剧情增加新的节拍'],
  [true, '根据剧情增加新的节拍'],
  [false, '不修改现有集号，只增加节拍'],
  [true, '不修改现有集号，只增加节拍'],
  [false, '保留现有分集，增加节拍'],
  [true, '保留现有分集，增加节拍'],
] as const)(
  '清除分集→新增→确认→保存重开→撤销重做保持未分集，围栏=%s，请求=%s',
  async (fenced, request) => {
    const h = await setup()
    act(() =>
      h.hook.result.current.patch.patchNode('b', {
        nodeType: 'beat',
        patch: { episodeNo: undefined },
      }),
    )
    h.refresh()
    expect(episodes(h.hook.result.current.doc.nodes)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ])
    expect(h.hook.result.current.ai.canvasDigest).toContain('b 未分集')
    expect(
      JSON.parse(h.hook.result.current.ai.readNode('b')!).data,
    ).not.toHaveProperty('episodeNo')
    const stale: AiCommand[] = [
      {
        op: 'create_node',
        nodeType: 'beat',
        data: { name: '新转折', episodeNo: 1 },
      },
      ...['s', 'd', 'r'].map((nodeId): AiCommand => ({
        op: 'update_node',
        nodeId,
        patch: { episodeNo: 1 },
      })),
    ]
    chat
      .mockResolvedValueOnce(reply(stale, fenced))
      .mockResolvedValueOnce(
        reply(
          [{ op: 'create_node', nodeType: 'beat', data: { name: '新转折' } }],
          fenced,
        ),
      )
    await send(request)
    expect(chat).toHaveBeenCalledTimes(2)
    await waitFor(() =>
      expect(
        h.saved[h.saved.length - 1]?.entries.find((entry) => entry.card)?.card
          ?.episodeScope,
      ).toBe('preserve'),
    )
    expect(h.hook.result.current.doc.nodes).toHaveLength(4)
    fireEvent.click(screen.getByRole('button', { name: /执行改动/ }))
    h.refresh()
    const doc = h.hook.result.current.doc
    expect(doc.nodes).toHaveLength(5)
    expect(episodes(doc.nodes)).toEqual(Array(5).fill(undefined))
    expectUnassignedReload(doc)
    act(() => h.history.undo())
    expect(h.hook.result.current.doc.nodes).toHaveLength(4)
    act(() => h.history.undo())
    expect(episodes(h.hook.result.current.doc.nodes)).toEqual([
      1,
      undefined,
      undefined,
      undefined,
    ])
    await act(() => h.history.redo())
    await act(() => h.history.redo())
    expect(episodes(h.hook.result.current.doc.nodes)).toEqual(
      Array(5).fill(undefined),
    )
    expect(h.hook.result.current.doc.edges).toEqual(project.edges)
  },
)

it('明确分集仍需预览确认，执行后一步撤销/重做', async () => {
  const h = await setup()
  chat.mockResolvedValue(
    reply([{ op: 'update_node', nodeId: 's', patch: { episodeNo: 2 } }]),
  )
  await send('把场景归入第 2 集')
  expect(episodes(h.hook.result.current.doc.nodes)).toEqual([
    1,
    undefined,
    undefined,
    undefined,
  ])
  fireEvent.click(screen.getByRole('button', { name: /执行改动/ }))
  expect(episodes(h.hook.result.current.doc.nodes)).toEqual([
    1,
    2,
    undefined,
    undefined,
  ])
  act(() => h.history.undo())
  expect(episodes(h.hook.result.current.doc.nodes)).toEqual([
    1,
    undefined,
    undefined,
    undefined,
  ])
  await act(() => h.history.redo())
  expect(episodes(h.hook.result.current.doc.nodes)).toEqual([
    1,
    2,
    undefined,
    undefined,
  ])
})

it('超过 200 条时原始请求被裁掉，合法分集卡仍可重开确认', async () => {
  const h = await setup()
  chat.mockResolvedValue(
    reply([{ op: 'update_node', nodeId: 's', patch: { episodeNo: 2 } }]),
  )
  await send('把场景归入第 2 集')
  await waitFor(() =>
    expect(
      h.saved[h.saved.length - 1]?.entries.some((entry) => entry.card),
    ).toBe(true),
  )
  const saved = h.saved[h.saved.length - 1]!
  const expanded: AiSession = {
    ...saved,
    entries: [
      ...saved.entries,
      ...Array.from({ length: 205 }, (_, i) => ({
        id: i + 10,
        kind: 'note' as const,
        text: `回执 ${i}`,
      })),
    ],
  }
  const disk = normalizeAiSession(
    JSON.parse(JSON.stringify(diskSessionOf(expanded))),
  ).session
  expect(disk.entries).toHaveLength(200)
  expect(disk.entries.some((entry) => entry.role === 'user')).toBe(false)
  cleanup()
  const restored = await setup(disk)
  const execute = screen.getByRole('button', {
    name: /执行改动/,
  }) as HTMLButtonElement
  expect(execute.disabled).toBe(false)
  fireEvent.click(execute)
  expect(episodes(restored.hook.result.current.doc.nodes)).toEqual([
    1,
    2,
    undefined,
    undefined,
  ])
})

it('模型持续夹带集号时耗尽预算，整批不可执行且不修改图', async () => {
  const h = await setup()
  chat.mockResolvedValue(
    reply([
      {
        op: 'create_node',
        nodeType: 'beat',
        data: { name: '新转折', episodeNo: 1 },
      },
      { op: 'update_node', nodeId: 's', patch: { episodeNo: 1 } },
    ]),
  )
  await send('根据剧情增加新的节拍')
  expect(chat).toHaveBeenCalledTimes(4)
  expect(
    (screen.getByRole('button', { name: /执行改动/ }) as HTMLButtonElement)
      .disabled,
  ).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: /执行改动/ }))
  expect(h.hook.result.current.doc.nodes).toEqual(project.nodes)
  expect(h.hook.result.current.doc.edges).toEqual(project.edges)
  expect(h.history.canUndo).toBe(false)
})

it('旧卡首次恢复即补齐分集范围，后续裁剪不失去原请求', async () => {
  const initial = await setup()
  const v = initial.hook.result.current.ai.validateCommands([
    { op: 'update_node', nodeId: 's', patch: { episodeNo: 2 } },
  ])!
  cleanup()
  const legacy = await setup({
    schemaVersion: 1,
    entries: [
      { id: 1, kind: 'msg', role: 'user', text: '把场景归入第 2 集' },
      {
        id: 2,
        kind: 'msg',
        role: 'assistant',
        text: '旧卡',
        card: { v, status: 'pending' },
      },
    ],
  })
  // 恢复本身不触发写盘；下一次真实会话变化才进入生产保存/裁剪边界。
  chat.mockResolvedValue({ role: 'assistant', content: '继续讨论。' })
  await send('继续讨论')
  await waitFor(() =>
    expect(
      legacy.saved[legacy.saved.length - 1]?.entries.find((entry) => entry.card)
        ?.card?.episodeScope,
    ).toBe('allow'),
  )
  const saved = legacy.saved[legacy.saved.length - 1]!
  const disk = normalizeAiSession(
    JSON.parse(
      JSON.stringify(
        diskSessionOf({
          ...saved,
          entries: [
            ...saved.entries,
            ...Array.from({ length: 205 }, (_, i) => ({
              id: i + 10,
              kind: 'note' as const,
              text: '回执',
            })),
          ],
        }),
      ),
    ),
  ).session
  cleanup()
  const restored = await setup(disk)
  fireEvent.click(screen.getByRole('button', { name: /执行改动/ }))
  expect(episodes(restored.hook.result.current.doc.nodes)).toEqual([
    1,
    2,
    undefined,
    undefined,
  ])
})

it.each([undefined, 'allow'] as const)(
  '恢复旧的新增节拍卡（范围=%s）不能借后续请求执行旧集号',
  async (episodeScope) => {
    const h = await setup()
    const v = h.hook.result.current.ai.validateCommands([
      { op: 'update_node', nodeId: 's', patch: { episodeNo: 1 } },
    ])!
    cleanup()
    const restored = await setup({
      schemaVersion: 1,
      entries: [
        { id: 1, kind: 'msg', role: 'user', text: '根据剧情增加新的节拍' },
        {
          id: 2,
          kind: 'msg',
          role: 'assistant',
          text: '旧预览',
          card: {
            v,
            status: 'pending',
            ...(episodeScope ? { episodeScope } : {}),
          },
        },
        { id: 3, kind: 'msg', role: 'user', text: '创建第一集' },
      ],
    })
    expect(
      (screen.getByRole('button', { name: /执行改动/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /执行改动/ }))
    expect(screen.getByText(/本轮未明确要求分集/)).toBeTruthy()
    expect(episodes(restored.hook.result.current.doc.nodes)).toEqual([
      1,
      undefined,
      undefined,
      undefined,
    ])
  },
)
