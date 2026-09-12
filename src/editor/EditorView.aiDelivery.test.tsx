// @vitest-environment happy-dom
/** #75：真实编辑器、IPC 序列化、校验、Flow／大纲和撤销链路；仅供应商与保存出口受控。 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import EditorView from './EditorView'
import type { EditorProjectContent } from './useEditorDocument'
import type { AssistantMessage, ChatMessage } from './ai/chat'
import type { AiSession } from './ai/session'
import type { ProjectContent } from '../model/content'
import { settingsStore } from '../settings/settingsStore'
import { buildCanvasNode } from './nodeFactory'
import { edgeKindOf } from './graphRules'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
const ipc = vi.mocked(invoke)
beforeEach(() => {
  Element.prototype.scrollTo = vi.fn()
  ipc.mockReset().mockResolvedValue({ role: 'assistant', content: '继续讨论。' })
  vi.spyOn(settingsStore, 'load').mockResolvedValue({ providers: [{
    id: 'p', label: '测试', baseUrl: 'https://example.test/v1', enabled: true,
    models: ['m'], keyEnc: 'pw1:test-fixture',
  }], defaultChat: 'p:m', defaultImage: null })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

/** 第二个节拍尚未兑现；两场既有内容使新增场景编号和目标关联可独立检查。 */
function project(): EditorProjectContent {
  const context = { against: [], characters: [], center: null }
  const nodes = [
    buildCanvasNode('beat', { data: { name: '开端' } }, context),
    buildCanvasNode('beat', { data: { name: '立势·对手亮肌肉' } }, context),
    buildCanvasNode('scene', { data: { name: '已有一', sceneNo: 1 } }, context),
    buildCanvasNode('scene', { data: { name: '已有二', sceneNo: 2 } }, context),
  ].map((node, index) => ({ ...node, id: `n${index + 1}`, position: { x: index * 300, y: 0 } }))
  return { id: 'delivery', name: '交付回归', nodes, edges: [], settings: { characters: [], locations: [] } }
}

/** 同一完整批次在两种协议下都须先展示、确认后才落地。 */
function proposal(fenced: boolean): AssistantMessage {
  const args = JSON.stringify({ commands: [
    { op: 'create_node', nodeType: 'scene', ref: 'new', data: { name: '吞并计划' } },
    { op: 'connect_edge', sourceId: 'n2', targetId: 'new' },
  ] })
  return fenced ? { role: 'assistant', content: `\`\`\`json\n${args}\n\`\`\`` }
    : { role: 'assistant', content: null, tool_calls: [{ id: 'write', type: 'function',
      function: { name: 'batch', arguments: args } }] }
}

/** 保存真实文档快照以核对关联，UI 查询分别限定大纲和 Flow。 */
async function setup(initial = project()) {
  const documents: ProjectContent[] = []
  const sessions: AiSession[] = []
  const view = render(<EditorView project={initial} onBackHome={() => undefined}
    onRenameProject={() => undefined} onSave={(doc) => { documents.push(doc) }}
    onSaveAiSession={async (session) => { sessions.push(session) }} />)
  fireEvent.click(screen.getByLabelText('切换 AI 面板'))
  await screen.findByLabelText('AI 对话输入')
  const flow = view.container.querySelector('.react-flow')! as HTMLElement
  return { document: () => documents[documents.length - 1],
    entry: () => sessions[sessions.length - 1]?.entries.slice(-1)[0],
    flow: within(flow), outline: within(screen.getByLabelText('故事大纲')) }
}

/** 等待发送完成，使用生产 UI 输入入口。 */
async function send(text: string) {
  const input = screen.getByLabelText('AI 对话输入')
  fireEvent.change(input, { target: { value: text } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(input).toHaveProperty('disabled', false))
}

describe('明确操作先交付预览，再由用户确认', () => {
  it.each([false, true])('第二节奏卡创建场景 fenced=%s：预览、同步、整批撤销且不重复执行', async (fenced) => {
    const h = await setup()
    ipc.mockResolvedValueOnce({ role: 'assistant', content: '明白，将在第二个节奏卡后创建场景。' })
      .mockResolvedValueOnce(proposal(fenced))
    await send('在第二个节奏卡，创建场景')
    expect(screen.getByLabelText('AI 改动预览')).toBeTruthy()
    expect(h.outline.queryByText('场 03 · 吞并计划')).toBeNull()
    expect(h.flow.queryByText('吞并计划')).toBeNull()
    expect(screen.getByLabelText('撤销')).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: '✓ 执行改动' }))
    expect(h.outline.getAllByText('场 03 · 吞并计划').length).toBeGreaterThan(0)
    await waitFor(() => expect(h.flow.getByText('吞并计划')).toBeTruthy())
    await waitFor(() => expect(h.document()?.nodes).toHaveLength(5))
    const doc = h.document()
    const added = doc.nodes.find((node) => !['n1', 'n2', 'n3', 'n4'].includes(node.id))!
    expect(doc.edges).toMatchObject([{ source: 'n2', target: added.id }])
    expect(edgeKindOf(doc.edges[0])).toBe('sequence')
    expect(doc.aiRevision).toBe(1)
    fireEvent.click(screen.getByLabelText('撤销'))
    expect(h.outline.queryByText('场 03 · 吞并计划')).toBeNull()
    await waitFor(() => expect(h.flow.queryByText('吞并计划')).toBeNull())
    await send('解释一下动机')
    await waitFor(() => expect(h.document()?.nodes).toHaveLength(4))
    expect(h.document()?.edges).toEqual([])
    expect(h.document()?.aiRevision).toBe(1)
    expect(screen.queryByRole('button', { name: '✓ 执行改动' })).toBeNull()
  })

  it('耗尽时显示可操作的失败说明，随所属助手消息保存且没有执行入口', async () => {
    const h = await setup()
    ipc.mockResolvedValue({ role: 'assistant', content: '本消息只包含改动批次，见预览卡。' })
    await send('增加下一个场景')
    expect(screen.getByText(/本轮未生成可执行改动/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '✓ 执行改动' })).toBeNull()
    expect(h.outline.queryByText('场 03 · 吞并计划')).toBeNull()
    expect(screen.getByLabelText('撤销')).toHaveProperty('disabled', true)
    await waitFor(() => expect(h.entry()?.text).toMatch(/本轮未生成可执行改动/))
    expect(h.entry()?.card).toBeUndefined()
  })

  it('扩写请求回显批次记录时无预览卡、画布不变且显示未交付诊断（issue 91）', async () => {
    const h = await setup()
    const echoed = '已完成扩写。\n\n[应用批次记录]\n' + JSON.stringify({
      batchId: 9, status: 'executed', commandCount: 1,
      changes: ['修改 对白·场04（lines）'], currentEffect: 'unknown',
    })
    ipc.mockResolvedValueOnce({ role: 'assistant', content: '修改场04的对白' })
      .mockResolvedValue({ role: 'assistant', content: echoed })
    await send('扩写场04的对白')
    expect(screen.queryByLabelText('AI 改动预览')).toBeNull()
    expect(screen.queryByRole('button', { name: '✓ 执行改动' })).toBeNull()
    expect(screen.getByText(/本轮未生成可执行改动/)).toBeTruthy()
    // 画布与撤销栈不变：无执行即无撤销项，大纲不出现新场景。
    expect(screen.getByLabelText('撤销')).toHaveProperty('disabled', true)
    expect(h.outline.queryByText(/场 03/)).toBeNull()
    await waitFor(() => expect(h.entry()?.text).toMatch(/本轮未生成可执行改动/))
    expect(h.entry()?.card).toBeUndefined()
  })
})

/** 示例协议是 JSON 围栏批次；受控供应商使用实际收到的示例，不在测试里重写命令。 */
function replyWithExample(messages: ChatMessage[], type: 'scene' | 'dialogue'): AssistantMessage {
  const batches = messages.filter((message) => message.role === 'system')
    .flatMap((message) => [...message.content.matchAll(/```json\n([\s\S]*?)\n```/g)])
    .map((match) => JSON.parse(match[1]) as { commands: Array<{ op: string; nodeType?: string }> })
  const batch = batches.find((candidate) => candidate.commands.some((command) =>
    command.op === 'create_node' && command.nodeType === type))
  return batch ? { role: 'assistant', content: null, tool_calls: [{ id: 'example', type: 'function',
    function: { name: 'batch', arguments: JSON.stringify(batch) } }] }
    : { role: 'assistant', content: '抱歉，这次我直接通过写工具输出完整批次。' }
}

/** 已有单一后继与一条无关路径；id 对应提示示例的占位对象，实际 UI 流程不替换它们。 */
function insertionProject(dialogue: boolean): EditorProjectContent {
  const initial = project()
  initial.nodes[1].id = 'A'
  const context = { against: [], characters: [], center: null }
  initial.nodes.push({ ...buildCanvasNode('beat', { data: { name: '试探交锋' } }, context), id: 'B' })
  if (dialogue) initial.nodes.push({ ...buildCanvasNode('scene', {
    data: { name: '吞并计划', sceneNo: 3 },
  }, context), id: 'C' })
  initial.edges = [
    { id: 'old', source: dialogue ? 'C' : 'A', target: 'B', className: 'pw-edge-sequence' },
    { id: 'unrelated', source: 'n1', target: 'n3', className: 'pw-edge-sequence' },
  ]
  return initial
}

/** 按语义比较剧情流端点，忽略运行时分配的边 id 与展示字段。 */
function links(doc: Pick<ProjectContent, 'edges'>) {
  return doc.edges.map((edge) => [edge.source, edge.target, edgeKindOf(edge)].join('→')).sort()
}

describe('发送给模型的完整场景插入示例', () => {
  it('替换旧直连、保留无关路径，确认和撤销同步画布与大纲', async () => {
    const initial = insertionProject(false)
    const h = await setup(initial)
    ipc.mockImplementation(async (_command, args) => replyWithExample(
      (args as { messages: ChatMessage[] }).messages, 'scene'))
    await send('在立势之后、试探交锋之前创建场景')
    expect(screen.getByLabelText('AI 改动预览')).toBeTruthy()
    expect(h.flow.queryByText('吞并计划')).toBeNull()
    expect(screen.getByLabelText('撤销')).toHaveProperty('disabled', true)
    expect(h.outline.queryByText('场 03 · 吞并计划')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '✓ 执行改动' }))
    await waitFor(() => expect(h.document()?.nodes).toHaveLength(6))
    const added = h.document().nodes.find((node) => !initial.nodes.some((old) => old.id === node.id))!
    expect(added.type).toBe('scene')
    expect(links(h.document())).toEqual([
      `A→${added.id}→sequence`, `${added.id}→B→sequence`, 'n1→n3→sequence',
    ].sort())
    expect(h.flow.getByText('吞并计划')).toBeTruthy()
    expect(h.outline.getAllByText('场 03 · 吞并计划').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByLabelText('撤销'))
    await waitFor(() => expect(h.document()?.nodes).toHaveLength(5))
    expect(links(h.document())).toEqual(links(initial))
    expect(h.flow.queryByText('吞并计划')).toBeNull()
    expect(h.outline.queryByText('场 03 · 吞并计划')).toBeNull()
  })
})

describe('发送给模型的完整角色与对白创建示例', () => {
  it('场03后插入对白，speaker 解析为新增角色，实体和剧情流同批撤销', async () => {
    const initial = insertionProject(true)
    const h = await setup(initial)
    ipc.mockImplementation(async (_command, args) => replyWithExample(
      (args as { messages: ChatMessage[] }).messages, 'dialogue'))
    await send('在场03后创建对白')
    expect(screen.getByLabelText('AI 改动预览')).toBeTruthy()
    expect(h.flow.queryByText('收购交锋')).toBeNull()
    expect(screen.getByLabelText('撤销')).toHaveProperty('disabled', true)
    expect(h.document()?.settings.characters ?? []).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: '✓ 执行改动' }))
    await waitFor(() => expect(h.document()?.nodes).toHaveLength(7))
    const doc = h.document()
    const added = doc.nodes.find((node) => node.type === 'dialogue')!
    const character = doc.settings.characters[0]
    expect(character.name).toBe('连锁店长')
    expect(character.id).not.toBe('manager')
    expect(added.data.lines).toMatchObject([
      { kind: 'line', speaker: character.id, text: '这份收购方案，你可以考虑一下。' },
      { kind: 'action', text: '店长把合同推到桌面中央。' },
    ])
    expect(links(doc)).toEqual([
      `C→${added.id}→sequence`, `${added.id}→B→sequence`, 'n1→n3→sequence',
    ].sort())
    expect(h.flow.getByText('收购交锋')).toBeTruthy()
    expect(h.outline.getByText('对白 · 收购交锋')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('撤销'))
    await waitFor(() => expect(h.document()?.nodes).toHaveLength(6))
    expect(h.document().settings.characters).toEqual([])
    expect(links(h.document())).toEqual(links(initial))
    expect(h.flow.queryByText('收购交锋')).toBeNull()
    expect(h.outline.queryByText('对白 · 收购交锋')).toBeNull()
  })
})
