// @vitest-environment happy-dom
/**
 * 编辑器右栏组件测试：检查器五类节点的只读字段派生（含失效引用）、
 * ✦AI 会话的引导态/模型选择、纯文本问答、读工具就地回喂循环、
 * 写工具 → 预览卡 → 执行/两步删除确认/忽略/失败回执、围栏批次回退。
 * llmChat 打桩（不触 IPC），settingsStore.load 打桩喂配置。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import RightPanel from './RightPanel'
import { llmChat, type AssistantMessage } from '../ai/chat'
import type { ChatMessage } from '../ai/chat'
import type { BatchValidation, ValidatedCommand } from '../ai/commands'
import { nodeFieldTableText } from '../ai/nodeFields'
import { normalizeAiSession, type AiSession } from '../ai/session'
import { settingsStore } from '../../settings/settingsStore'
import type { AppSettings } from '../../settings/types'
import type { ProjectSettings } from '../settings'
import type { CanvasNode } from '../nodes/types'

vi.mock('../ai/chat', () => ({ llmChat: vi.fn() }))
const llmChatMock = vi.mocked(llmChat)

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

beforeAll(() => {
  Element.prototype.scrollTo = vi.fn() // happy-dom 未实现
})

beforeEach(() => {
  llmChatMock.mockReset()
})

const SETTINGS: ProjectSettings = {
  characters: [{ id: 'c1', name: '林晚', gradient: 'g1' }],
  locations: [{ id: 'l1', name: '天台' }],
}

/** keyEnc 已配置（truthy 即视为已配置，密文形状不在此断言）。 */
const APP_WITH_KEY = {
  providers: [
    {
      id: 'openai',
      label: 'OpenAI 兼容',
      baseUrl: 'https://api.openai.com/v1',
      enabled: true,
      models: ['gpt-4o'],
      keyEnc: 'v1:x',
    },
  ],
  defaultChat: 'openai:gpt-4o',
} as unknown as AppSettings

const APP_NO_KEY = {
  providers: [
    {
      id: 'openai',
      label: 'OpenAI 兼容',
      baseUrl: 'https://api.openai.com/v1',
      enabled: true,
      models: ['gpt-4o'],
    },
  ],
  defaultChat: null,
} as unknown as AppSettings

function setup(over: Partial<Parameters<typeof RightPanel>[0]> = {}) {
  const spies = {
    onResize: vi.fn(),
    onTabChange: vi.fn(),
    onOpenSettings: vi.fn(),
    onValidateAi: vi.fn((): BatchValidation | null => null),
    onValidateCommands: vi.fn((): BatchValidation | null => null),
    onReadNode: vi.fn(() => '{"id":"n1"}'),
    onApplyAiBatch: vi.fn((): string | null => null),
  }
  render(
    <RightPanel
      open
      width={320}
      tab="inspector"
      settings={SETTINGS}
      canvasDigest="SNAPSHOT"
      {...spies}
      {...over}
    />,
  )
  return spies
}

const sceneNode = {
  id: 's1',
  type: 'scene',
  position: { x: 0, y: 0 },
  data: {
    name: '场一', sceneNo: 3, interior: true, locationId: 'l1', time: '🌙 夜',
    weather: '雨', synopsis: '开局', characterIds: ['c1', 'gone'],
  },
} as CanvasNode

describe('RightPanel 检查器', () => {
  it('无选中显示空态引导', () => {
    setup()
    expect(screen.getByText('在画布中选择一个节点，查看它的字段。')).toBeTruthy()
  })

  it('场景行：场号补零、地点解析、失效引用标记、分镜计数', () => {
    setup({ selectedNode: sceneNode, attachedShotCount: 2 })
    expect(screen.getByText('场景 · 索引卡')).toBeTruthy()
    expect(screen.getByText('SCENE 03')).toBeTruthy()
    expect(screen.getByText('天台')).toBeTruthy()
    expect(screen.getByText('🎞 2 镜')).toBeTruthy()
    // 在场角色：c1 解析为名字，gone 标记（已删除）
    expect(screen.getByText('林晚 / （已删除）')).toBeTruthy()
  })

  it('对白/分支/分镜/节奏各行派生', () => {
    const mk = (type: CanvasNode['type'], data: Record<string, unknown>) =>
      ({ id: 'x', type, position: { x: 0, y: 0 }, data }) as CanvasNode

    const { unmount } = render(
      <RightPanel open width={320} tab="inspector" settings={SETTINGS} onResize={vi.fn()}
        onTabChange={vi.fn()}
        selectedNode={mk('dialogue', {
          name: '对白一',
          lines: [
            { kind: 'line', speaker: 'c1', text: '喂' },
            { kind: 'line', speaker: 'gone', text: '……' },
            { kind: 'action', text: '雨声' },
          ],
        })} />,
    )
    expect(screen.getByText('林晚 / （已删除）')).toBeTruthy()
    expect(screen.getByText('2 句')).toBeTruthy()
    expect(screen.getByText('1 行')).toBeTruthy()
    unmount()

    setup({
      selectedNode: mk('branch', {
        prompt: '怎么办？',
        options: [{ id: 'oa', label: 'A' }, { id: 'ob', label: 'B' }],
      }),
    })
    expect(screen.getByText('A / B')).toBeTruthy()
    cleanup()
    setup({ selectedNode: mk('shot', { shotNo: 2, size: '特写', picture: '车窗', prompt: 'p', refs: [{ kind: 'character', label: '垫图' }] }) })
    expect(screen.getByText('SHOT 02')).toBeTruthy()
    expect(screen.getByText('垫图')).toBeTruthy()
    cleanup()
    setup({ selectedNode: mk('beat', { name: '节拍一', tone: '紧张' }) })
    expect(screen.getByText('节奏卡 · 节拍胶囊')).toBeTruthy()
    expect(screen.getByText('紧张')).toBeTruthy()
  })

  it('分段切换透传 onTabChange', () => {
    const spies = setup()
    fireEvent.click(screen.getByRole('button', { name: '✦ AI' }))
    expect(spies.onTabChange).toHaveBeenCalledWith('ai')
  })
})

/** 切到 AI 分段并等配置加载完。 */
async function toAiTab(app: AppSettings, over: Partial<Parameters<typeof RightPanel>[0]> = {}) {
  vi.spyOn(settingsStore, 'load').mockResolvedValue(app)
  const spies = setup({ tab: 'ai', ...over })
  await screen.findByLabelText('AI 对话输入')
  return spies
}

const send = (text: string) => {
  const input = screen.getByLabelText('AI 对话输入')
  fireEvent.change(input, { target: { value: text } })
  fireEvent.keyDown(input, { key: 'Enter' })
}

const reply = (over: Partial<AssistantMessage>): AssistantMessage => ({
  role: 'assistant',
  content: null,
  ...over,
})

describe('RightPanel ✦AI 引导与模型', () => {
  it('未配置 key：引导页 + 输入禁用 + 选项标（未配置 key）', async () => {
    const spies = await toAiTab(APP_NO_KEY)
    expect(screen.getByText('尚未接入 AI 服务')).toBeTruthy()
    expect(screen.getByText(/尚未配置 API key/)).toBeTruthy()
    expect((screen.getByLabelText('AI 对话输入') as HTMLInputElement).disabled).toBe(true)
    const opt = screen.getByRole('option', { name: /未配置 key/ }) as HTMLOptionElement
    expect(opt.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /前往设置页/ }))
    expect(spies.onOpenSettings).toHaveBeenCalled()
  })

  it('已配置 key：空线程提示；画布快照开关可关', async () => {
    await toAiTab(APP_WITH_KEY)
    expect(screen.getByText(/和 AI 聊聊这一幕怎么写/)).toBeTruthy()
    const toggle = screen.getByRole('button', { name: /了解当前画布/ })
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
  })
})

describe('RightPanel ✦AI 对话', () => {
  it('纯文本问答：消息序列含系统提示与画布快照，回复上屏', async () => {
    const spies = await toAiTab(APP_WITH_KEY)
    llmChatMock.mockResolvedValue(reply({ content: '建议先立冲突。' }))
    send('这一幕怎么写？')
    expect(await screen.findByText('建议先立冲突。')).toBeTruthy()
    expect(screen.getByText('这一幕怎么写？')).toBeTruthy()

    const messages = llmChatMock.mock.calls[0][2] as ChatMessage[]
    expect(messages[0].role).toBe('system')
    expect(messages.some((m) => m.content.includes('SNAPSHOT'))).toBe(true)
    expect(messages[messages.length - 1]).toEqual({ role: 'user', content: '这一幕怎么写？' })
    expect(spies.onValidateAi).toHaveBeenCalledWith('建议先立冲突。')
  })

  it('读工具循环：快照就地回喂后重问，第二轮出结论', async () => {
    await toAiTab(APP_WITH_KEY)
    llmChatMock
      .mockResolvedValueOnce(
        reply({
          content: '',
          tool_calls: [
            { id: 't1', type: 'function', function: { name: 'get_graph_snapshot', arguments: '{}' } },
          ],
        }),
      )
      .mockResolvedValueOnce(reply({ content: '画布有两场戏。' }))
    send('看看画布')
    expect(await screen.findByText('画布有两场戏。')).toBeTruthy()
    expect(llmChatMock).toHaveBeenCalledTimes(2)
    const round2 = llmChatMock.mock.calls[1][2] as ChatMessage[]
    const toolMsg = round2.find((m) => m.role === 'tool')
    expect(toolMsg?.content).toBe('SNAPSHOT')
    expect(toolMsg?.tool_call_id).toBe('t1')
  })

  it('get_node 读工具按 id 现查；模型报错上屏为错误条', async () => {
    const spies = await toAiTab(APP_WITH_KEY)
    llmChatMock
      .mockResolvedValueOnce(
        reply({
          content: '',
          tool_calls: [
            { id: 't2', type: 'function', function: { name: 'get_node', arguments: '{"nodeId":"n1"}' } },
          ],
        }),
      )
      .mockResolvedValueOnce(reply({ content: '节点已读。' }))
    send('读节点')
    expect(await screen.findByText('节点已读。')).toBeTruthy()
    expect(spies.onReadNode).toHaveBeenCalledWith('n1')

    llmChatMock.mockRejectedValueOnce(new Error('网络超时'))
    send('再来')
    expect(await screen.findByText(/网络超时/)).toBeTruthy()
  })
})

describe('RightPanel ✦AI 会话历史保持', () => {
  it('切到检查器再返回时保留同一项目的会话历史', async () => {
    vi.spyOn(settingsStore, 'load').mockResolvedValue(APP_WITH_KEY)
    llmChatMock.mockResolvedValue(reply({ content: '先让人物目标相撞。' }))
    const props = {
      open: true,
      width: 320,
      tab: 'ai' as const,
      settings: SETTINGS,
      onResize: vi.fn(),
      onTabChange: vi.fn(),
      canvasDigest: 'SNAPSHOT',
    }
    const view = render(<RightPanel {...props} />)
    await screen.findByLabelText('AI 对话输入')
    send('怎么增强冲突？')
    expect(await screen.findByText('先让人物目标相撞。')).toBeTruthy()

    view.rerender(<RightPanel {...props} tab="inspector" />)
    view.rerender(<RightPanel {...props} tab="ai" />)

    expect(await screen.findByText('怎么增强冲突？')).toBeTruthy()
    expect(screen.getByText('先让人物目标相撞。')).toBeTruthy()
  })
})

/** 一条合法 create 命令与对应校验结果的桩。 */
const CREATE_CMD: ValidatedCommand = { op: 'create_node', nodeType: 'scene', ref: 'a', data: { name: '场二' } }

const validationOf = (over: Partial<BatchValidation> = {}): BatchValidation => ({
  ok: true,
  items: [{ kind: 'create', danger: false, label: '新建 场景 · 场二', key: 'c0' }],
  commands: [CREATE_CMD],
  issues: [],
  hasDeletes: false,
  ...over,
})

const batchReply = () =>
  reply({
    content: '',
    tool_calls: [
      {
        id: 'w1',
        type: 'function',
        function: { name: 'batch', arguments: JSON.stringify({ commands: [CREATE_CMD] }) },
      },
    ],
  })

describe('RightPanel ✦AI 改动预览卡', () => {
  it('写工具批次 → 预览卡 → 执行成功回执', async () => {
    const spies = await toAiTab(APP_WITH_KEY)
    spies.onValidateCommands.mockReturnValue(validationOf())
    llmChatMock.mockResolvedValue(batchReply())
    send('加一场戏')
    expect(await screen.findByText('✦ 改动预览 · 1 项')).toBeTruthy()
    expect(screen.getByText('新建 场景 · 场二')).toBeTruthy()
    expect(spies.onValidateCommands).toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '✓ 执行改动' }))
    expect(spies.onApplyAiBatch).toHaveBeenCalledWith([expect.objectContaining({ op: 'create_node' })])
    expect(await screen.findByText(/✓ 已执行 1 项改动/)).toBeTruthy()
    // 当前会话内执行的卡才宣称 ⌘Z 整批撤销；回执作为持久历史不携带该宣称
    expect(screen.getAllByText(/⌘Z 可整批撤销/)).toHaveLength(1)
  })

  it('含删除批次：执行按钮两步武装确认', async () => {
    const spies = await toAiTab(APP_WITH_KEY)
    spies.onValidateCommands.mockReturnValue(
      validationOf({
        items: [{ kind: 'delete', danger: true, label: '删除 场景 · 场一', key: 'd0' }],
        hasDeletes: true,
      }),
    )
    llmChatMock.mockResolvedValue(batchReply())
    send('删掉第一场')
    const armBtn = await screen.findByRole('button', { name: /执行（含 1 项删除）/ })
    fireEvent.click(armBtn)
    expect(spies.onApplyAiBatch).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: '再点一次确认执行删除' }))
    expect(spies.onApplyAiBatch).toHaveBeenCalled()
  })

  it('忽略：预览卡消失且不执行；执行失败出错误回执', async () => {
    const spies = await toAiTab(APP_WITH_KEY)
    spies.onValidateCommands.mockReturnValue(validationOf())
    llmChatMock.mockResolvedValue(batchReply())
    send('加一场')
    fireEvent.click(await screen.findByRole('button', { name: '忽略' }))
    expect(screen.queryByLabelText('AI 改动预览')).toBeNull()
    expect(spies.onApplyAiBatch).not.toHaveBeenCalled()

    spies.onApplyAiBatch.mockReturnValue('节点被占用')
    llmChatMock.mockResolvedValue(batchReply())
    send('再加一场')
    fireEvent.click(await screen.findByRole('button', { name: '✓ 执行改动' }))
    expect(await screen.findByText(/执行失败：节点被占用/)).toBeTruthy()
  })

  it('校验不通过：列出问题、执行禁用、画布未变提示', async () => {
    const spies = await toAiTab(APP_WITH_KEY)
    spies.onValidateCommands.mockReturnValue(
      validationOf({ ok: false, issues: [{ index: 0, message: '不能自环' }] }),
    )
    llmChatMock.mockResolvedValue(batchReply())
    send('加')
    expect(await screen.findByText('第 1 条：不能自环')).toBeTruthy()
    expect(screen.getByText('批次未通过校验，画布未发生任何变化。')).toBeTruthy()
    expect((screen.getByRole('button', { name: '✓ 执行改动' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('围栏批次回退：无工具服务走 ```json 文本协议，围栏文本不上屏', async () => {
    const spies = await toAiTab(APP_WITH_KEY)
    spies.onValidateAi.mockReturnValue(validationOf())
    llmChatMock.mockResolvedValue(
      reply({ content: '我建议加一场。\n```json\n{"commands":[]}\n```' }),
    )
    send('给点建议')
    expect(await screen.findByText('✦ 改动预览 · 1 项')).toBeTruthy()
    expect(screen.getByText('我建议加一场。')).toBeTruthy()
    expect(screen.queryByText(/```json/)).toBeNull()
    expect(spies.onValidateAi).toHaveBeenCalled()
  })
})

describe('RightPanel ✦AI 执行回执落盘时序', () => {
  it('画布未确认落盘时按 pending 落盘且不落回执，确认后才写 executed', async () => {
    let confirmCanvas!: () => void
    const whenCanvasCommitted = vi.fn(
      () => new Promise<void>((resolve) => { confirmCanvas = resolve }),
    )
    const saved: AiSession[] = []
    const onSaveSession = vi.fn(async (session: AiSession) => { saved.push(session) })
    const spies = await toAiTab(APP_WITH_KEY, {
      whenCanvasCommitted,
      aiRevision: 4,
      onSaveAiSession: onSaveSession,
    })
    spies.onValidateCommands.mockReturnValue(validationOf())
    llmChatMock.mockResolvedValue(batchReply())
    send('加一场戏')
    await screen.findByText('✦ 改动预览 · 1 项')

    fireEvent.click(screen.getByRole('button', { name: '✓ 执行改动' }))
    expect(await screen.findByText(/✓ 已执行 1 项改动/)).toBeTruthy()
    // 画布尚未确认：落盘的是可重新执行的 pending 卡（带执行后计数供对账），
    // 回执不得先于画布落盘
    await waitFor(() => expect(saved.length).toBeGreaterThan(0))
    const before = saved[saved.length - 1]
    expect(before.entries.find((e) => e.card)?.card).toMatchObject({
      status: 'pending',
      aiRevisionAfter: 5,
    })
    expect(before.entries.some((e) => e.kind === 'note' && e.text.includes('已执行'))).toBe(false)

    await act(async () => { confirmCanvas() })
    await waitFor(() => {
      const after = saved[saved.length - 1]
      expect(after.entries.find((e) => e.card)?.card?.status).toBe('executed')
      expect(after.entries.some((e) => e.kind === 'note' && e.text.includes('已执行'))).toBe(true)
    })
  })
})

describe('RightPanel ✦AI 回执关联剔除', () => {
  it('执行非末尾的待执行卡：回执按关联剔除，画布确认后才随卡片落盘', async () => {
    let confirmCanvas!: () => void
    const whenCanvasCommitted = vi.fn(
      () => new Promise<void>((resolve) => { confirmCanvas = resolve }),
    )
    const saved: AiSession[] = []
    const onSaveSession = vi.fn(async (session: AiSession) => { saved.push(session) })
    const spies = await toAiTab(APP_WITH_KEY, {
      whenCanvasCommitted,
      aiRevision: 2,
      onSaveAiSession: onSaveSession,
    })
    spies.onValidateCommands.mockReturnValue(validationOf())
    llmChatMock.mockResolvedValue(batchReply())
    send('加一场戏')
    await screen.findByText('✦ 改动预览 · 1 项')
    // 卡片不再是会话末尾：其后追加一轮普通问答
    llmChatMock.mockResolvedValue(reply({ content: '继续讨论。' }))
    send('继续讨论')
    await screen.findByText('继续讨论。')
    await waitFor(() => expect(saved.length).toBeGreaterThan(0))
    const beforeClick = saved.length

    fireEvent.click(screen.getByRole('button', { name: '✓ 执行改动' }))
    expect(await screen.findByText(/✓ 已执行 1 项改动/)).toBeTruthy()
    await waitFor(() => expect(saved.length).toBeGreaterThan(beforeClick))
    // 回执追加在会话尾部而非卡片紧邻位置，但必须按关联剔除
    const before = saved[saved.length - 1]
    expect(before.entries.find((e) => e.card)?.card?.status).toBe('pending')
    expect(before.entries.some((e) => e.kind === 'note' && e.text.includes('已执行'))).toBe(false)

    await act(async () => { confirmCanvas() })
    await waitFor(() => {
      const after = saved[saved.length - 1]
      expect(after.entries.find((e) => e.card)?.card?.status).toBe('executed')
      expect(after.entries.some((e) => e.kind === 'note' && e.text.includes('已执行'))).toBe(true)
    })
  })
})

describe('RightPanel ✦AI 执行卡落盘对账', () => {
  const uncommittedSession = () => ({
    schemaVersion: 1 as const,
    entries: [
      {
        id: 1,
        kind: 'msg' as const,
        role: 'assistant' as const,
        text: '未确认落盘的批次。',
        card: { v: validationOf(), status: 'pending' as const, aiRevisionAfter: 5 },
      },
    ],
  })

  it('画布计数未达执行后计数：批次未落盘，恢复为可再次执行的待执行卡', async () => {
    const validate = vi.fn(() => validationOf())
    await toAiTab(APP_WITH_KEY, {
      aiSession: uncommittedSession(),
      aiRevision: 4,
      onValidateCommands: validate,
    })
    expect(validate).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '✓ 执行改动' })).toBeTruthy()
    expect(screen.queryByText(/历史改动/)).toBeNull()
  })

  it('画布计数已达执行后计数：批次已随画布落盘，恢复为不可再执行的历史卡', async () => {
    await toAiTab(APP_WITH_KEY, {
      aiSession: uncommittedSession(),
      aiRevision: 5,
    })
    expect(screen.getByText(/历史改动/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '✓ 执行改动' })).toBeNull()
    expect(screen.queryByText(/⌘Z 可整批撤销/)).toBeNull()
  })
})

describe('RightPanel ✦AI 恢复卡重校验', () => {
  it('恢复的已执行卡标注为历史改动，不宣称当前撤销栈可整批撤销', async () => {
    await toAiTab(APP_WITH_KEY, {
      aiSession: {
        schemaVersion: 1,
        entries: [{
          id: 1,
          kind: 'msg',
          role: 'assistant',
          text: '先前的改动。',
          card: { v: validationOf(), status: 'executed' },
        }],
      },
    })
    expect(screen.getByText(/已执行/)).toBeTruthy()
    expect(screen.queryByText(/⌘Z 可整批撤销/)).toBeNull()
  })

  it('恢复待执行卡时按当前画布重建删除风险，仍要求两步确认', async () => {
    const deleteCommand: ValidatedCommand = { op: 'delete_node', nodeId: 's1' }
    const stalePreview = validationOf({ commands: [deleteCommand] })
    const currentPreview = validationOf({
      commands: [deleteCommand],
      items: [{ kind: 'delete', danger: true, label: '删除 场景 · 场一', key: 'd0' }],
      hasDeletes: true,
    })
    const validate = vi.fn(() => currentPreview)
    await toAiTab(APP_WITH_KEY, {
      aiSession: {
        schemaVersion: 1,
        entries: [{
          id: 1,
          kind: 'msg',
          role: 'assistant',
          text: '已恢复的改动。',
          card: { v: stalePreview, status: 'pending' },
        }],
      },
      onValidateCommands: validate,
    })

    expect(validate).toHaveBeenCalledWith([deleteCommand])
    expect(screen.getByRole('button', { name: /执行（含 1 项删除）/ })).toBeTruthy()
  })
})

describe('RightPanel ✦AI 会话保存错误', () => {
  const sessionOf = (text: string) => ({
    schemaVersion: 1 as const,
    entries: [{ id: 1, kind: 'msg' as const, role: 'assistant' as const, text }],
  })

  it('带保存错误进入面板时首帧即重试落盘，成功后提示消除', async () => {
    const onSaveSession = vi.fn(() => Promise.resolve())
    await toAiTab(APP_WITH_KEY, {
      aiSession: sessionOf('已恢复的历史'),
      aiSessionError: 'Error: 磁盘已满',
      onSaveAiSession: onSaveSession,
    })

    expect(onSaveSession).toHaveBeenCalledWith(sessionOf('已恢复的历史'))
    await waitFor(() =>
      expect(screen.queryByText(/聊天记录保存失败/)).toBeNull(),
    )
  })

  it('无错误时挂载不重复保存初始会话', async () => {
    const onSaveSession = vi.fn().mockResolvedValue(undefined)
    await toAiTab(APP_WITH_KEY, {
      aiSession: sessionOf('已恢复的历史'),
      onSaveAiSession: onSaveSession,
    })
    expect(onSaveSession).not.toHaveBeenCalled()
  })

  it('读取失败的空回退会话禁止挂载落盘（原文件可能可恢复）', async () => {
    const onSaveSession = vi.fn().mockResolvedValue(undefined)
    await toAiTab(APP_WITH_KEY, {
      aiSession: { schemaVersion: 1, entries: [] },
      aiSessionError: 'Error: 会话文件损坏',
      aiSessionRetryable: false,
      onSaveAiSession: onSaveSession,
    })
    expect(onSaveSession).not.toHaveBeenCalled()
    expect(screen.getByText(/聊天记录保存失败/)).toBeTruthy()
  })

  it('项目级保存错误在挂载后到达时同步进面板（重挂载期保存在途）', async () => {
    vi.spyOn(settingsStore, 'load').mockResolvedValue(APP_WITH_KEY)
    const props = {
      open: true,
      width: 320,
      tab: 'ai' as const,
      settings: SETTINGS,
      onResize: vi.fn(),
      onTabChange: vi.fn(),
      canvasDigest: 'SNAPSHOT',
    }
    const view = render(<RightPanel {...props} />)
    await screen.findByLabelText('AI 对话输入')

    view.rerender(<RightPanel {...props} aiSessionError="Error: 磁盘已满" />)

    expect(await screen.findByText(/聊天记录保存失败/)).toBeTruthy()
    expect(screen.getByText(/磁盘已满/)).toBeTruthy()
  })
})

describe('RightPanel ✦AI 恢复条目重定基', () => {
  it('恢复条目 id 达到安全整数上限时重定基，新增条目落盘 id 仍可归一化', async () => {
    let saved: unknown
    const onSaveSession = vi.fn((session: unknown) => {
      saved = session
      return Promise.resolve()
    })
    llmChatMock.mockResolvedValue(reply({ content: '收到。' }))
    await toAiTab(APP_WITH_KEY, {
      aiSession: {
        schemaVersion: 1,
        entries: [
          { id: Number.MAX_SAFE_INTEGER, kind: 'msg' as const, role: 'user' as const, text: '旧消息' },
        ],
      },
      onSaveAiSession: onSaveSession,
    })
    send('新消息')
    expect(await screen.findByText('收到。')).toBeTruthy()

    const entries = (saved as { entries: { id: number }[] }).entries
    expect(entries.map((entry) => entry.id)).toEqual([1, 2, 3])
    expect(normalizeAiSession(saved).repaired).toBe(false)
  })
})

describe('RightPanel ✦AI 字段协议（issue 41）', () => {
  it('系统提示嵌入共享节点字段表，模型拿得到 beat 的合法字段', async () => {
    await toAiTab(APP_WITH_KEY)
    llmChatMock.mockResolvedValue(reply({ content: '好的。' }))
    send('这一幕怎么写？')
    await screen.findByText('好的。')
    const messages = llmChatMock.mock.calls[0][2] as ChatMessage[]
    expect(messages[0].role).toBe('system')
    expect(messages[0].content).toContain(nodeFieldTableText())
    expect(messages[0].content).toContain('episodeNo')
  })

})

describe('RightPanel ✦AI 校验失败纠错重试（issue 41）', () => {
  it('校验失败回喂模型重试：纠正批次出预览卡，确认前画布不变', async () => {
    const spies = await toAiTab(APP_WITH_KEY)
    spies.onValidateCommands
      .mockReturnValueOnce(
        validationOf({
          ok: false,
          items: [],
          commands: [],
          issues: [{ index: 0, message: '未知字段：label（节奏卡 允许：name、tone、episodeNo）' }],
        }),
      )
      .mockReturnValueOnce(validationOf())
    const badBatch = () =>
      reply({
        content: '',
        tool_calls: [
          {
            id: 'w1',
            type: 'function',
            function: {
              name: 'batch',
              arguments: JSON.stringify({
                commands: [{ op: 'create_node', nodeType: 'beat', data: { label: '立足' } }],
              }),
            },
          },
        ],
      })
    llmChatMock.mockResolvedValueOnce(badBatch()).mockResolvedValueOnce(batchReply())
    send('创建一组街口餐饮商战主题的节奏卡')

    expect(await screen.findByText('✦ 改动预览 · 1 项')).toBeTruthy()
    expect(llmChatMock).toHaveBeenCalledTimes(2)
    // 错误清单按 tool 协议回喂进第二次请求
    const second = llmChatMock.mock.calls[1][2] as ChatMessage[]
    const toolMsg = second.find((m) => m.role === 'tool')
    expect(toolMsg?.tool_call_id).toBe('w1')
    expect(toolMsg?.content).toContain('未知字段：label')
    // 闭环结束画布仍零副作用，用户确认才落地
    expect(spies.onApplyAiBatch).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '✓ 执行改动' }))
    expect(spies.onApplyAiBatch).toHaveBeenCalled()
  })

})

describe('RightPanel ✦AI 重试耗尽（issue 41）', () => {
  it('重试耗尽：错误卡片保留，画布未变提示在场', async () => {
    const spies = await toAiTab(APP_WITH_KEY)
    spies.onValidateCommands.mockReturnValue(
      validationOf({ ok: false, items: [], commands: [], issues: [{ index: 0, message: '未知字段：label' }] }),
    )
    llmChatMock.mockResolvedValue(
      reply({
        content: '',
        tool_calls: [
          {
            id: 'w1',
            type: 'function',
            function: {
              name: 'batch',
              arguments: JSON.stringify({
                commands: [{ op: 'create_node', nodeType: 'beat', data: { label: '立足' } }],
              }),
            },
          },
        ],
      }),
    )
    send('创建节奏卡')
    expect(await screen.findByText('第 1 条：未知字段：label')).toBeTruthy()
    expect(screen.getByText('批次未通过校验，画布未发生任何变化。')).toBeTruthy()
    expect((screen.getByRole('button', { name: '✓ 执行改动' }) as HTMLButtonElement).disabled).toBe(true)
    expect(spies.onApplyAiBatch).not.toHaveBeenCalled()
  })
})
