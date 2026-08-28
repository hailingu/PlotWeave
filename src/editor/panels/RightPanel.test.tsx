// @vitest-environment happy-dom
/**
 * 编辑器右栏组件测试：检查器五类节点的只读字段派生（含失效引用）、
 * ✦AI 会话的引导态/模型选择、纯文本问答、读工具就地回喂循环、
 * 写工具 → 预览卡 → 执行/两步删除确认/忽略/失败回执、围栏批次回退。
 * llmChat 打桩（不触 IPC），settingsStore.load 打桩喂配置。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import RightPanel from './RightPanel'
import { llmChat, type AssistantMessage } from '../ai/chat'
import type { ChatMessage } from '../ai/chat'
import type { AiCommand, BatchValidation } from '../ai/commands'
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
async function toAiTab(app: AppSettings) {
  vi.spyOn(settingsStore, 'load').mockResolvedValue(app)
  const spies = setup({ tab: 'ai' })
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

/** 一条合法 create 命令与对应校验结果的桩。 */
const CREATE_CMD = { op: 'create_node', nodeType: 'scene', ref: 'a', data: { name: '场二' } } as unknown as AiCommand

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
    expect(screen.getByText(/✓ 已执行，⌘Z 可整批撤销/)).toBeTruthy()
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
