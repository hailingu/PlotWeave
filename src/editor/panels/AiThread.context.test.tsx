// @vitest-environment happy-dom
/**
 * #73 跨轮上下文回归：真实面板、校验/执行桥、撤销栈与请求序列化共同运行。
 * 仅替换外部 IPC 和应用设置读取；画布采用与 EditorView 等价的状态容器，
 * 会话保存经过 JSON 序列化和生产归一化，验证发送边界而非模型的随机措辞。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { invoke } from '@tauri-apps/api/core'
import type { ChatMessage, AssistantMessage } from '../ai/chat'
import type { AiCommand } from '../ai/commands'
import { normalizeAiSession, type AiSession } from '../ai/session'
import { useAiBridge, type AiBridgeDeps } from '../useAiBridge'
import { CommandStack } from '../history'
import { EMPTY_SETTINGS } from '../settings'
import { mergeNodeData } from '../nodes/patch'
import type { CanvasNode, DialogueFlowNode } from '../nodes/types'
import { settingsStore } from '../../settings/settingsStore'
import RightPanel from './RightPanel'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
const invokeMock = vi.mocked(invoke)

beforeEach(() => {
  Element.prototype.scrollTo = vi.fn()
  invokeMock.mockReset().mockResolvedValue({ role: 'assistant', content: '继续讨论。' })
  vi.spyOn(settingsStore, 'load').mockResolvedValue({
    providers: [{
      id: 'test', label: '测试服务', baseUrl: 'https://example.test/v1', enabled: true,
      models: ['test-model'], keyEnc: 'pw1:test-fixture',
    }],
    defaultChat: 'test:test-model', defaultImage: null,
  })
})

afterEach(() => { cleanup(); vi.restoreAllMocks() })

/** 空的开场对白；测试通过真实 update_node 命令写入 action 旁白。 */
function dialogueNode(texts: string[] = []): DialogueFlowNode {
  return {
    id: 'd1', type: 'dialogue', position: { x: 0, y: 0 },
    data: { name: '开场', lines: texts.map((text, i) => ({ id: `a${i}`, kind: 'action', text })) },
  }
}

/** 工具与围栏两种供应商响应都进入生产批次解析、校验与预览流程。 */
function proposal(fenced = false): AssistantMessage {
  const commands = [{ op: 'update_node', nodeId: 'd1', patch: {
    lines: dialogueNode(['旁白一', '旁白二', '旁白三', '旁白四']).data.lines,
  } }]
  const args = JSON.stringify({ commands })
  if (fenced) return { role: 'assistant', content: `给开场补充旁白。\n\`\`\`json\n${args}\n\`\`\`` }
  return { role: 'assistant', content: '给开场补充旁白。', tool_calls: [{
    id: 'batch-1', type: 'function', function: { name: 'batch', arguments: args },
  }] }
}

/** 模拟 EditorView 的状态写入依赖；业务校验、模拟执行与命令栈保持真实。 */
function canvasHarness(initialNodes: CanvasNode[] = [dialogueNode()], aiRevision = 0) {
  const state = { nodes: initialNodes, aiRevision }
  const history = new CommandStack()
  const deps: AiBridgeDeps = {
    nodes: state.nodes, edges: [], settings: EMPTY_SETTINGS,
    nodesRef: { current: state.nodes }, edgesRef: { current: [] },
    settingsRef: { current: EMPTY_SETTINGS }, assetsRef: { current: { byId: {} } },
    buildNewNode: () => { throw new Error('此用例只允许更新现有节点') },
    applyDataPatch: (id, cmd) => deps.setNodes((nodes) =>
      nodes.map((node) => node.id === id ? mergeNodeData(node, cmd.patch) : node)),
    setNodes: (update) => {
      state.nodes = update(state.nodes)
      deps.nodes = state.nodes
      deps.nodesRef.current = state.nodes
    },
    setEdges: (update) => { deps.edges = update(deps.edges); deps.edgesRef.current = deps.edges },
    setSettings: (update) => {
      deps.settings = update(deps.settings); deps.settingsRef.current = deps.settings
    },
    setAiRevision: (update) => { state.aiRevision = update(state.aiRevision) },
    pushHistory: (command) => history.push(command), closeSettings: () => undefined,
  }
  const hook = renderHook(() => useAiBridge(deps))
  return { state, history, deps, hook }
}

/** 装配真实右栏和 AI 桥；refresh 对应画布更新后 EditorView 的重渲染。
 * projectId 用于在途回合的项目归属（issue #63）——跨用例模块级注册表
 * 共享，需要隔离的用例显式传入独立 id。 */
async function setup(options: {
  session?: AiSession
  aiRevision?: number
  nodes?: CanvasNode[]
  whenCanvasCommitted?: () => Promise<void>
  projectId?: string
} = {}) {
  const canvas = canvasHarness(options.nodes, options.aiRevision)
  const saved: AiSession[] = []
  const props = () => ({
    open: true, width: 320, tab: 'ai' as const, settings: EMPTY_SETTINGS,
    projectId: options.projectId ?? 'p-context',
    onResize: () => undefined, onTabChange: () => undefined,
    canvasDigest: canvas.hook.result.current.canvasDigest,
    onValidateCommands: canvas.hook.result.current.validateCommands,
    onValidateAi: canvas.hook.result.current.validateAiReply,
    onApplyAiBatch: canvas.hook.result.current.applyAiBatch,
    onReadNode: canvas.hook.result.current.readNode,
    aiSession: options.session, aiRevision: canvas.state.aiRevision,
    whenCanvasCommitted: options.whenCanvasCommitted,
    onSaveAiSession: async (session: AiSession) => { saved.push(JSON.parse(JSON.stringify(session)) as AiSession) },
  })
  const view = render(<RightPanel {...props()} />)
  await screen.findByLabelText('AI 对话输入')
  return {
    ...canvas, saved,
    refresh: () => { canvas.hook.rerender(); view.rerender(<RightPanel {...props()} />) },
    unmount: () => { view.unmount(); canvas.hook.unmount() },
  }
}

/** 使用真实输入入口，并等待 Agent 循环结束，避免发送中重复操作。 */
async function send(text = '再丰富点') {
  const input = screen.getByLabelText('AI 对话输入')
  fireEvent.change(input, { target: { value: text } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(input).toHaveProperty('disabled', false))
}

/** 读取实际 llm_chat IPC 负载，包含 chat.ts 序列化后的消息。 */
function lastRequest(): ChatMessage[] {
  const call = invokeMock.mock.calls[invokeMock.mock.calls.length - 1]
  expect(call[0]).toBe('llm_chat')
  return (call[1] as { messages: ChatMessage[] }).messages
}

/** §12.2 每条助手消息的应用批次 JSON 记录，不能依赖孤立 note 回执。 */
function records(messages = lastRequest()): Record<string, unknown>[] {
  return messages.filter((message) => message.role === 'assistant').flatMap((message) => {
    const record = message.content.split('\n[应用批次记录]\n')[1]
    return record ? [JSON.parse(record) as Record<string, unknown>] : []
  })
}

describe('AiThread 确认后下一轮的真实请求', () => {
  it.each([false, true])('工具/围栏通道 fenced=%s：较早卡片执行后状态仍绑定原批次', async (fenced) => {
    const h = await setup()
    invokeMock.mockResolvedValueOnce(proposal(fenced))
    await send('丰富开场点题的旁白')
    expect(h.state.nodes[0].data.lines).toEqual([])
    await send('先解释一下')
    expect(records()).toMatchObject([{ batchId: 2, status: 'pending', commandCount: 1 }])
    fireEvent.click(screen.getByRole('button', { name: '✓ 执行改动' }))
    h.refresh()
    expect(h.state.nodes[0].data.lines).toHaveLength(4)
    expect(h.state.aiRevision).toBe(1)
    await send()
    expect(records()).toMatchObject([{
      batchId: 2, status: 'executed', commandCount: 1, currentEffect: 'unknown',
    }])
    expect(lastRequest().find((m) => m.content.startsWith('当前画布快照'))?.content).toContain('4 条旁白/动作')
    expect(lastRequest().some((m) => m.role === 'tool' || m.tool_calls)).toBe(false)
  })

  it('忽略后继续提问仍带 dismissed，关闭快照不删除对话的批次状态', async () => {
    const h = await setup()
    invokeMock.mockResolvedValueOnce(proposal())
    await send('丰富旁白')
    fireEvent.click(screen.getByRole('button', { name: '忽略' }))
    fireEvent.click(screen.getByRole('button', { name: /了解当前画布/ }))
    await send()
    expect(records()).toMatchObject([{ status: 'dismissed' }])
    expect(lastRequest().some((m) => m.content.startsWith('当前画布快照'))).toBe(false)
    expect(h.state.nodes[0].data.lines).toEqual([])
    expect(h.history.canUndo).toBe(false)
  })
})

describe('AiThread 失败恢复与成功重试', () => {
  it('预览后目标被删除：执行失败进入下一轮，恢复会话后重试成功清除旧失败', async () => {
    const h = await setup()
    invokeMock.mockResolvedValueOnce(proposal())
    await send('丰富旁白')
    h.deps.setNodes(() => [])
    h.refresh()
    fireEvent.click(screen.getByRole('button', { name: '✓ 执行改动' }))
    await send()
    expect(h.state.nodes).toEqual([])
    expect(h.state.aiRevision).toBe(0)
    expect(h.history.canUndo).toBe(false)
    expect(records()).toMatchObject([{ status: 'execution_failed', executionError: expect.stringContaining('d1') }])
    const session = normalizeAiSession(h.saved[h.saved.length - 1]).session
    h.unmount()
    // 目标在重开前恢复：重新校验可执行，但上次失败记录仍是历史事实。
    const reopened = await setup({ session })
    await send('上次如何')
    expect(records()).toMatchObject([{ status: 'execution_failed' }])
    fireEvent.click(screen.getByRole('button', { name: '✓ 执行改动' }))
    reopened.refresh()
    await send()
    expect(reopened.state.nodes[0].data.lines).toHaveLength(4)
    expect(records()).toMatchObject([{ status: 'executed' }])
    expect(records()[0]).not.toHaveProperty('executionError')
    expect(reopened.saved[reopened.saved.length - 1].entries.find((e) => e.card)!.card).not.toHaveProperty('executionError')
  })

  it('执行失败后忽略同一卡片，后续请求及保存不再携带旧失败状态', async () => {
    const h = await setup()
    invokeMock.mockResolvedValueOnce(proposal())
    await send('丰富旁白')
    h.deps.setNodes(() => [])
    h.refresh()
    fireEvent.click(screen.getByRole('button', { name: '✓ 执行改动' }))
    fireEvent.click(screen.getByRole('button', { name: '忽略' }))
    await send()
    expect(records()).toMatchObject([{ status: 'dismissed' }])
    expect(records()[0]).not.toHaveProperty('executionError')
    expect(h.saved[h.saved.length - 1].entries.find((e) => e.card)!.card).not.toHaveProperty('executionError')
    expect(h.history.canUndo).toBe(false)
  })
})

describe('AiThread 执行与保存是独立事实', () => {
  it('画布确认前模型知道已在内存执行，持久会话仍待对账；确认后去掉未保存提示', async () => {
    let confirm!: () => void
    const committed = new Promise<void>((resolve) => { confirm = resolve })
    const h = await setup({ whenCanvasCommitted: () => committed })
    invokeMock.mockResolvedValueOnce(proposal())
    await send('丰富旁白')
    fireEvent.click(screen.getByRole('button', { name: '✓ 执行改动' }))
    h.refresh()
    await send()
    expect(records()).toMatchObject([{ status: 'executed', canvasSavePending: true }])
    expect(h.saved[h.saved.length - 1].entries.find((e) => e.card)!.card).toMatchObject({ status: 'pending', aiRevisionAfter: 1 })
    await act(async () => { confirm() })
    await send()
    expect(records()).toMatchObject([{ status: 'executed' }])
    expect(records()[0]).not.toHaveProperty('canvasSavePending')
    expect(h.saved[h.saved.length - 1].entries.find((e) => e.card)!.card?.status).toBe('executed')
  })

  it.each([{ revision: 0, status: 'pending' }, { revision: 1, status: 'executed' }])(
    '未确认批次重开后按画布计数 $revision 对账再发送 $status', async ({ revision, status }) => {
      const h = await setup({ whenCanvasCommitted: () => new Promise<void>(() => undefined) })
      invokeMock.mockResolvedValueOnce(proposal())
      await send('丰富旁白')
      fireEvent.click(screen.getByRole('button', { name: '✓ 执行改动' }))
      await send()
      const session = normalizeAiSession(h.saved[h.saved.length - 1]).session
      const nodes = revision === 1 ? h.state.nodes : [dialogueNode()]
      h.unmount()
      await setup({ session, nodes, aiRevision: revision })
      await send('重开后继续')
      expect(records()).toMatchObject([{ status }])
      expect(records()[0]).not.toHaveProperty('canvasSavePending')
      expect(Boolean(screen.queryByRole('button', { name: '✓ 执行改动' }))).toBe(status === 'pending')
      if (status === 'pending') {
        fireEvent.click(screen.getByRole('button', { name: '✓ 执行改动' }))
        await send('确认后继续')
        expect(records()).toMatchObject([{ status: 'executed', commandCount: 1 }])
      }
    },
  )
})

describe('AiThread 恢复待执行卡的校验边界', () => {
  it('重开时目标已不存在，转换入站形态后仍按当前图拒绝整批', async () => {
    const h = await setup()
    invokeMock.mockResolvedValueOnce(proposal())
    await send('丰富旁白')
    const session = normalizeAiSession(h.saved[h.saved.length - 1]).session
    h.unmount()
    const reopened = await setup({ session, nodes: [] })
    await send()
    expect(records()).toMatchObject([{ status: 'validation_failed' }])
    expect((screen.getByRole('button', { name: '✓ 执行改动' }) as HTMLButtonElement).disabled).toBe(true)
    expect(reopened.history.canUndo).toBe(false)
  })

  it.each([false, true])('校验拒绝卡（兼容合法子集=%s）重开后仍保持整批拒绝', async (withSubset) => {
    const h = await setup()
    const commands: AiCommand[] = [
      { op: 'update_node', nodeId: 'd1', patch: { name: '新名称' } },
      { op: 'update_node', nodeId: 'missing', patch: { name: '无效目标' } },
    ]
    invokeMock.mockResolvedValue({ role: 'assistant', content: '建议两项修改。', tool_calls: [{
      id: 'bad-batch', type: 'function', function: { name: 'batch', arguments: JSON.stringify({ commands }) },
    }] })
    await send('修改两个节点')
    const session = normalizeAiSession(h.saved[h.saved.length - 1]).session
    const rejected = session.entries.find((e) => e.card)!.card!
    expect(rejected.v).toMatchObject({ ok: false, commands: [] })
    // 当前拒绝结果不保留命令；兼容契约允许存在已校验的子集，两者都不是原始整批。
    if (withSubset) rejected.v.commands = h.hook.result.current.validateCommands([commands[0]])!.commands
    h.unmount()
    const reopened = await setup({ session })
    invokeMock.mockResolvedValue({ role: 'assistant', content: '继续讨论。' })
    await send()
    expect(records()).toMatchObject([{ status: 'validation_failed' }])
    expect((screen.getByRole('button', { name: '✓ 执行改动' }) as HTMLButtonElement).disabled).toBe(true)
    expect(reopened.state.nodes[0].data.name).toBe('开场')
    expect(reopened.history.canUndo).toBe(false)
  })
})

describe('AiThread 历史成功不覆盖当前画布', () => {
  it('执行后撤销或手动编辑，get_node 回喂当前字段，批次只保留曾执行事实', async () => {
    const h = await setup()
    invokeMock.mockResolvedValueOnce(proposal())
    await send('丰富旁白')
    fireEvent.click(screen.getByRole('button', { name: '✓ 执行改动' }))
    h.history.undo()
    h.refresh()
    expect(h.state.nodes[0].data.lines).toEqual([])
    await readCurrentNode()
    expect(JSON.parse(lastRequest().find((m) => m.role === 'tool')!.content).data.lines).toEqual([])
    expect(records()).toMatchObject([{ status: 'executed', currentEffect: 'unknown' }])
    h.deps.setNodes(() => [dialogueNode(['手动写的新旁白'])])
    h.refresh()
    await readCurrentNode()
    expect(JSON.parse(lastRequest().find((m) => m.role === 'tool')!.content).data.lines)
      .toEqual([{ id: 'a0', kind: 'action', text: '手动写的新旁白' }])
    expect(records()).toMatchObject([{ status: 'executed', currentEffect: 'unknown' }])
  })
})

/** 供应商请求读取详情，经真实 Agent 读工具回喂后再发出第二轮请求。 */
async function readCurrentNode() {
  invokeMock.mockResolvedValueOnce({ role: 'assistant', content: null, tool_calls: [{
    id: 'read-1', type: 'function', function: { name: 'get_node', arguments: '{"nodeId":"d1"}' },
  }] })
  await send('读取现在的旁白')
}

describe('AiThread 在途回合跨卸载按项目认领（issue #63）', () => {
  /** 发送后仅等到 llm_chat 已发出：在途回合留在按项目登记的注册表
   * （见 pendingTurns），不等待模型落定。 */
  async function sendInFlight(text = '丰富开场') {
    const input = screen.getByLabelText('AI 对话输入')
    fireEvent.change(input, { target: { value: text } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() =>
      expect(invokeMock.mock.calls.some(([cmd]) => cmd === 'llm_chat')).toBe(true))
  }

  /** 首个 llm_chat 调用挂起至手动落定，模拟回合跨设置页/首页往返。 */
  function deferredReply() {
    let resolve!: (message: AssistantMessage) => void
    invokeMock.mockImplementationOnce(
      () => new Promise<AssistantMessage>((settle) => { resolve = settle }),
    )
    return (message: AssistantMessage) => resolve(message)
  }

  /** 同上，但落定为失败：拒绝须发生在卸载之后，故不能直接用已拒绝值。 */
  function deferredFailure() {
    let reject!: (err: Error) => void
    invokeMock.mockImplementationOnce(
      () => new Promise<AssistantMessage>((_, fail) => { reject = fail }),
    )
    return (err: Error) => reject(err)
  }

  /** 宏任务边界冲刷全部在途微任务：卸载后的落定/失败在无 DOM 可观察时完成。 */
  async function flushAfterUnmount() {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  }

  it('迟到完成的回复经重挂载认领：重定 id 入列并经保存通道落盘', async () => {
    const reply = deferredReply()
    const h = await setup({ projectId: 'p63-claim' })
    await sendInFlight()
    expect(screen.getByText('✦ 正在思考…')).toBeTruthy()
    const session = normalizeAiSession(h.saved[h.saved.length - 1]).session
    h.unmount() // ⌘, 进入设置：编辑器整体卸载，回合仍在途
    await act(async () => { reply({ role: 'assistant', content: '迟到回复。' }) })
    const reopened = await setup({ projectId: 'p63-claim', session })
    expect(await screen.findByText('迟到回复。')).toBeTruthy()
    expect(screen.queryByText('✦ 正在思考…')).toBeNull()
    const last = reopened.saved[reopened.saved.length - 1]
    expect(last.entries.map((e) => e.role ?? e.kind)).toEqual(['user', 'assistant'])
    expect(new Set(last.entries.map((e) => e.id)).size).toBe(2)
  })

  it('重挂载时回合仍在途：忙碌态恢复，落定后上屏', async () => {
    const reply = deferredReply()
    const h = await setup({ projectId: 'p63-wait' })
    await sendInFlight()
    const session = normalizeAiSession(h.saved[h.saved.length - 1]).session
    h.unmount()
    await setup({ projectId: 'p63-wait', session })
    expect(screen.getByText('✦ 正在思考…')).toBeTruthy()
    await act(async () => { reply({ role: 'assistant', content: '等待后到达。' }) })
    expect(await screen.findByText('等待后到达。')).toBeTruthy()
    expect(screen.queryByText('✦ 正在思考…')).toBeNull()
  })

  it('卸载期间请求失败：重挂载显示错误，不追加条目不触发保存', async () => {
    const fail = deferredFailure()
    const h = await setup({ projectId: 'p63-fail' })
    await sendInFlight()
    const session = normalizeAiSession(h.saved[h.saved.length - 1]).session
    h.unmount()
    await act(async () => { fail(new Error('网络中断')) }) // 失败在卸载后落定
    await flushAfterUnmount()
    const reopened = await setup({ projectId: 'p63-fail', session })
    expect(await screen.findByText(/网络中断/)).toBeTruthy()
    expect(screen.queryByText('✦ 正在思考…')).toBeNull()
    expect(reopened.saved).toHaveLength(0)
  })

  it('认领后再次卸载：回合归还注册表，下次挂载继续认领', async () => {
    const reply = deferredReply()
    const h = await setup({ projectId: 'p63-return' })
    await sendInFlight()
    const session = normalizeAiSession(h.saved[h.saved.length - 1]).session
    h.unmount()
    const middle = await setup({ projectId: 'p63-return', session })
    expect(screen.getByText('✦ 正在思考…')).toBeTruthy()
    middle.unmount() // 等待期间再次进入设置
    await setup({ projectId: 'p63-return', session })
    expect(screen.getByText('✦ 正在思考…')).toBeTruthy()
    await act(async () => { reply({ role: 'assistant', content: '辗转到达。' }) })
    expect(await screen.findByText('辗转到达。')).toBeTruthy()
  })

  it('认领的迟到批次按当前画布重校验：目标已删则整批拒绝执行', async () => {
    // 在途回合约住已卸载实例的校验闭包（issue #63 评审）：迟到批次的
    // 预览若沿用离开前的旧校验结果，用户会基于过期预览确认执行。
    const reply = deferredReply()
    const h = await setup({ projectId: 'p63-revalidate' })
    await sendInFlight('丰富旁白')
    const session = normalizeAiSession(h.saved[h.saved.length - 1]).session
    h.unmount()
    await act(async () => { reply(proposal()) }) // 旧闭包校验通过（d1 仍在旧画布）
    await setup({ projectId: 'p63-revalidate', session, nodes: [] }) // 重开后目标已删
    expect(await screen.findByText(/给开场补充旁白/)).toBeTruthy()
    const execute = screen.getByRole('button', { name: '✓ 执行改动' }) as HTMLButtonElement
    expect(execute.disabled).toBe(true)
    const claimed = screen.getByRole('button', { name: '✓ 执行改动' }).closest('.pw-ai-entry')
    expect(claimed?.textContent).toContain('第 1 条')
  })
})
