// @vitest-environment jsdom
/**
 * 自动无障碍审计（issue #238 建立，issue #363 扩面）：axe-core 规则扫描
 * 覆盖全部可达界面的渲染树，每棵树一个 `audit()` 断言，阻断 violations
 * 以及 incomplete 中的 aria-prohibited-attr（issue #500），输出可定位
 * 诊断（结果类别、规则 id、影响、帮助文案、触发选择器、规则文档链接）。
 *
 * 覆盖的渲染树：
 * - 首页：正常态、错误态、重命名对话框、删除确认对话框
 * - 设置页：Provider 配置与模型表单
 * - 编辑器装配：标题栏/三栏 + **真实画布**（示例项目全量节点与边：
 *   sequence / attach / branch 三类连线、分支选项端口与选项胶囊）
 * - 编辑器浮层：画布右键菜单（节点/连线/空白三形态）、六类节点设置表单、
 *   设定文档编辑弹窗
 * - ✦AI 会话面板：含线程内容（用户消息 + 助手消息 + 已执行改动预览卡）
 * - 全局降级与诊断：崩溃屏（ErrorBoundary）、退出冲刷阻塞横幅
 *
 * 已禁用规则与不可覆盖项（披露）：
 * - `color-contrast` 依赖真实渲染引擎的样式计算，合成 DOM 中结果不可信，
 *   禁用并保留人工验收（issue #238 验收说明）。**显式前提**：默认主题
 *   的文字对比度不由本审计兜底，而由令牌层负责——该范围的配对数值与
 *   处置已登记为已接受边界（issue #351，`known-boundary`）。二者择一
 *   恒成立：若 #351 的边界被撤销并改为扩测默认主题，本条前提失效，
 *   须在同一改动中恢复 `color-contrast` 或改用带样式表的审计环境。
 * - 自动扫描不覆盖真实 WebView 行为与屏幕阅读器播报（见 PR 说明）。
 * - 其余 incomplete 仍需人工判断，不由本文件自动阻断；无布局 DOM 的
 *   dialog 顶层命中栈由垫片保持为空，不验证遮挡与 inert 行为。
 * - 键盘流程另由 `editorKeyboardFlows.test.tsx`、`ExportDialog` 焦点
 *   陷阱与 `PanelResizer` ARIA 分隔条覆盖，本文件不重复建设。
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HomePage } from './home/HomePage'
import type { ProjectSummary } from './home/projects'
import { ConfirmDeleteDialog, RenameDialog } from './home/Dialogs'
import { SettingsView } from './settings/SettingsView'
import { settingsStore } from './settings/settingsStore'
import { defaultSettings } from './settings/types'
import { ExportDialog } from './editor/ExportDialog'
import type { ScriptExportModel } from './editor/exportScript'
import { EditorView } from './editor/EditorView'
import type { EditorProjectContent } from './editor/useEditorDocument'
import { SAMPLE_NODES, SAMPLE_EDGES } from './editor/sampleGraph'
import {
  SAMPLE_SETTINGS,
  LIN_WAN_ID,
  CHEN_MO_ID,
  LOC_ROOFTOP_ID,
} from './editor/sampleData'
import { CanvasContextMenu } from './editor/CanvasContextMenu'
import { DocumentEditorDialog } from './editor/panels/DocumentEditorDialog'
import { NodeSettingsPanel } from './editor/nodes/settings/NodeSettingsPanel'
import type { PanelNode } from './editor/nodes/settings/panelNode'
import { NodeEditContext, type NodeEditApi } from './editor/nodeEdit'
import { ImageGenContext, type ImageGenApi } from './editor/imagegen/context'
import { ErrorBanner } from './editor/ErrorBanner'
import { ErrorBoundary } from './ErrorBoundary'
import type { AiSession } from './ai/session'
import type { BatchValidation } from './editor/ai/commands'
import type { DocumentEntity } from './editor/settings'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/* -------------------------------------------------------------------------
 * 画布测量 shim（issue #363）
 *
 * 连线要真正进入审计 DOM，前提是 React Flow 认为节点「已测量」：
 * `isNodeInitialized` 同时要求非零 `measured` 与 `internals.handleBounds`，
 * 后者由 ResizeObserver 回调触发的 `updateNodeInternals` 写入，而该函数
 * 又依赖 `window.DOMMatrixReadOnly` 解析视口 transform。jsdom 三者全缺：
 * offsetWidth/offsetHeight 恒 0、无 DOMMatrixReadOnly、ResizeObserver 缺失。
 * 只桩其中一两个会让所有 EdgeWrapper 静默返回 null——审计「通过」但
 * 连线根本没被扫描。因此这里补齐最小测量能力，语义如实标注。
 * ---------------------------------------------------------------------- */

/** `DOMMatrixReadOnly` 最小替身：只解析审计需要的 matrix()/scale()，
 * 其余（缺省/`none`）按单位阵处理——视口缩放即 m22 = 1。 */
class AuditMatrix {
  m11 = 1
  m12 = 0
  m21 = 0
  m22 = 1
  m41 = 0
  m42 = 0
  constructor(transform?: string) {
    const matched = /matrix\(([^)]+)\)/.exec(transform ?? '')
    if (!matched) return
    const parts = matched[1].split(',').map((v) => Number(v.trim()))
    this.m11 = parts[0] ?? 1
    this.m12 = parts[1] ?? 0
    this.m21 = parts[2] ?? 0
    this.m22 = parts[3] ?? 1
    this.m41 = parts[4] ?? 0
    this.m42 = parts[5] ?? 0
  }
}

/** ResizeObserver 替身：observe 即投递一条含 contentRect 的 entry
 * （XYPanZoom 的 extent 观察者与节点测量观察者各读其中不同字段），
 * 异步投递以贴合真实观察者时序。 */
class AuditResizeObserver {
  private readonly callback: ResizeObserverCallback
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
  }
  observe(target: Element) {
    const rect = { width: 1024, height: 768 }
    queueMicrotask(() => {
      this.callback(
        [{ target, contentRect: rect } as unknown as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      )
    })
  }
  unobserve() {}
  disconnect() {}
}

/** 装齐 jsdom 缺失的画布测量能力：非零 offsetWidth/offsetHeight、
 * DOMMatrixReadOnly 与可触发的 ResizeObserver。幂等，可重复调用。 */
function installCanvasMetrics() {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>
  const dims = { configurable: true }
  Object.defineProperty(proto, 'offsetWidth', { ...dims, get: () => 220 })
  Object.defineProperty(proto, 'offsetHeight', { ...dims, get: () => 96 })
  Object.defineProperty(window, 'DOMMatrixReadOnly', {
    configurable: true,
    value: AuditMatrix,
  })
  globalThis.ResizeObserver =
    AuditResizeObserver as unknown as typeof ResizeObserver
}
installCanvasMetrics()

// jsdom 无布局命中测试，也没有 showModal 的顶层；本审计的 dialog[open]
// 全部直接渲染为普通 DOM。空命中栈避免 axe 的模态探测因 API 缺失抛错，
// 并让背景与弹窗都继续受审计；真实顶层遮挡／inert 行为仍属 WebView 验收。
Object.defineProperty(document, 'elementsFromPoint', {
  configurable: true,
  value: () => [],
})

// 同因：jsdom 的 HTMLElement 无 scrollTo（AI 线程挂载滚动到最新条目），
// Element 无 scrollIntoView（左栏大纲把选中节点滚入视野）
if (typeof HTMLElement.prototype.scrollTo !== 'function') {
  HTMLElement.prototype.scrollTo = (() => {}) as unknown as () => void
}
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = (() => {}) as unknown as () => void
}

beforeEach(async () => {
  // 设置页与 AI 面板的内存 store 是模块级单例：每例前重置，避免串扰
  await settingsStore.save(defaultSettings())
})

/** 扫描渲染树，阻断违例与可判定的禁止属性命中（issue #500）。 */
async function audit(container: HTMLElement, context: string) {
  const results = await axe.run(container, {
    rules: {
      // 视觉对比度需真实样式计算（合成 DOM 无样式渲染），结果不可信：
      // 禁用并保留人工验收（issue #238 验收说明）。默认主题的对比度
      // 范围由令牌层承担，已登记为已接受边界（#351）——见模块头前提。
      'color-contrast': { enabled: false },
    },
  })
  // axe 把无 role 容器的 aria-label 归入 incomplete；这类标签语义缺失
  // 已有可判定触发条件，必须失败。其余 incomplete 仍需人工判断，
  // 本次不把合成 DOM 无法确定的结果直接升级为 violation。
  const findings = [
    ...results.violations.map((result) => ({ kind: 'violation', result })),
    ...results.incomplete
      .filter((result) => result.id === 'aria-prohibited-attr')
      .map((result) => ({ kind: 'incomplete', result })),
  ]
  const lines = findings.map(
    ({ kind, result: v }) =>
      `${kind} ${v.id}（${v.impact ?? '未分级'}）：${v.help}｜触点 ${v.nodes
        .map((n) => n.target.join(' '))
        .join(' ; ')}｜${v.helpUrl}`,
  )
  expect(lines, `${context} 存在可访问性规则违例\n${lines.join('\n')}`).toEqual(
    [],
  )
}

/** 等待画布完成节点测量并挂出连线（测量是异步的，见 installCanvasMetrics）。 */
async function awaitCanvasEdges(container: HTMLElement) {
  await waitFor(() => {
    expect(
      container.querySelectorAll('.react-flow__edge').length,
    ).toBeGreaterThan(0)
  })
}

const project: ProjectSummary = {
  id: 'p1',
  name: '都市奇缘',
  sceneCount: 3,
  updatedAt: '2026-09-21T00:00:00.000Z',
}

const exportModel: ScriptExportModel = {
  plain: '# 正文\n第一场',
  outline: '# 正文\n第一场\n\n## 附录 · 创作大纲\n\n- 节拍 · 立势',
  hasNarrative: true,
  summary: {
    episodes: [1],
    scenes: 1,
    dialogues: 1,
    beats: 1,
    branches: 0,
    hasOutline: true,
  },
  scopeLine: '1 集 · 1 场 · 1 对白 · 1 节拍',
}

/** 编辑器审计树：示例项目的全量节点与边（issue #363）。此前用 1 节点
 * 0 边的夹具，连线/端口/分支胶囊完全没进 axe——现换成生产种子数据，
 * sequence / attach / branch 三类边与分支选项端口都真实渲染。 */
const editorProject: EditorProjectContent = {
  id: 'p1',
  name: '审计项目',
  nodes: SAMPLE_NODES,
  edges: SAMPLE_EDGES,
  settings: SAMPLE_SETTINGS,
}

/** 节点设置表单夹具：六类表单各一份，id 与实体引用指向示例项目
 * （SAMPLE_SETTINGS），梗概/选项/引用位带真实文案——空表单扫不到
 * chips、下拉与引用位的可访问名（issue #363）。图片节点示例图未含，
 * 按 ImageSpec 契约另建一份。 */
const panelNodes: PanelNode[] = [
  {
    id: 'n-scene',
    type: 'scene',
    data: {
      name: '雨夜天台',
      sceneNo: 3,
      interior: false,
      locationId: LOC_ROOFTOP_ID,
      time: '🌙 夜',
      weather: '🌧 雨',
      synopsis: '林晚翻出父亲死亡当夜的档案，陈默突然出现。',
      characterIds: [LIN_WAN_ID, CHEN_MO_ID],
      episodeNo: 1,
    },
  },
  {
    id: 'n-beat',
    type: 'beat',
    data: { name: '雨夜对峙', tone: '压抑渐强', episodeNo: 1 },
  },
  {
    id: 'n-dialogue',
    type: 'dialogue',
    data: {
      name: '真相逼近',
      episodeNo: 1,
      lines: [
        {
          id: 'l1',
          kind: 'line',
          speaker: LIN_WAN_ID,
          side: 'left',
          text: '你早就知道，对吗？',
        },
        { id: 'l2', kind: 'action', text: '陈默沉默，雨声渐大' },
      ],
    },
  },
  {
    id: 'n-branch',
    type: 'branch',
    data: {
      prompt: '林晚是否发现真相？',
      episodeNo: 1,
      options: [
        { id: 'opt-a', label: '坦白' },
        { id: 'opt-b', label: '隐瞒' },
      ],
    },
  },
  {
    id: 'n-shot',
    type: 'shot',
    data: {
      shotNo: 1,
      size: '远景',
      picture: '雨夜城市天台全景，林晚撑伞走出阴影。',
      prompt: 'rainy rooftop at night, cinematic wide shot',
      refs: [
        { id: 'ref-1', kind: 'character', label: '林晚垫图' },
        { id: 'ref-2', kind: 'location', label: '天台底图' },
        { id: 'ref-3', kind: 'audio', label: '雨声' },
      ],
    },
  },
  {
    id: 'n-image',
    type: 'image',
    data: {
      prompt: 'rainy rooftop at night, cinematic wide shot',
      model: 'test:image-model',
      size: '1024x1536',
      outputs: {},
    },
  },
]

/** 节点编辑上下文替身：设置面板的写动作全部无副作用，审计只读渲染结果。 */
const nodeEditApi: NodeEditApi = {
  projectId: 'p1',
  openSettingsId: null,
  toggleSettings: vi.fn(),
  closeSettings: vi.fn(),
  patchNode: vi.fn(),
  duplicateNode: vi.fn(),
  deleteNode: vi.fn(),
  shotCountOf: () => 0,
  beatFulfillmentOf: () => null,
  settings: SAMPLE_SETTINGS,
  assets: undefined,
}

/** 图像生成调度替身：图片节点表单经 useImageJobs 取能力，越界即抛错。 */
const imageGenApi: ImageGenApi = {
  jobOf: () => null,
  start: vi.fn(),
  cancel: vi.fn(),
}

/** AI 改动预览卡批次：含危险删除项，使两步确认执行与 danger 样式进入审计。 */
const aiBatch: BatchValidation = {
  ok: true,
  items: [
    { kind: 'update', danger: false, label: '改写「真相逼近」对白', key: '0' },
    { kind: 'delete', danger: true, label: '删除节点「旧公寓」', key: '1' },
  ],
  commands: [],
  issues: [],
  hasDeletes: true,
}

/** AI 会话夹具：用户消息 + 助手消息 + 已执行改动预览卡——覆盖真实线程
 * 形态（issue #363：既有审计只挂了空线程）。 */
const aiSession: AiSession = {
  schemaVersion: 1,
  entries: [
    { id: 1, kind: 'msg', role: 'user', text: '给开场补充三条旁白。' },
    { id: 2, kind: 'msg', role: 'assistant', text: '已生成三条旁白，请确认。' },
    {
      id: 3,
      kind: 'msg',
      role: 'assistant',
      text: '',
      card: { v: aiBatch, status: 'executed', historical: true },
    },
  ],
}

/** 设定文档夹具：带关联条目的正文，chips 切换区才有真实内容。 */
const documentEntity: DocumentEntity = {
  id: 'doc-1',
  title: '世界观 · 雨城',
  body: '雨季长达九个月。城里的信号塔从不在雨停时亮起。',
  relatedIds: [{ kind: 'character', id: 'ch-linwan' }],
}

/** 带 Provider 与已配置密钥的应用设置：AI 面板的输入框据此解除禁用。 */
const readySettings = {
  providers: [
    {
      id: 'test',
      label: '测试服务',
      baseUrl: 'https://example.test/v1',
      enabled: true,
      models: ['test-model'],
      keyEnc: 'pw1:test-fixture',
    },
  ],
  defaultChat: 'test:test-model',
  defaultImage: null,
}

describe('无障碍审计口径回归（issue #500）', () => {
  it.each([false, true])(
    '变异守卫：受审计树（含弹窗=%s）的无 role 标签容器必须失败，恢复分组后通过',
    async (withDialog) => {
      const { container } = render(
        <>
          <HomePage
            projects={[project]}
            onOpenProject={vi.fn()}
            onCreateProject={vi.fn()}
            onRenameProject={vi.fn()}
            onDuplicateProject={vi.fn()}
            onDeleteProject={vi.fn()}
          />
          {withDialog && (
            <ConfirmDeleteDialog
              title="审计弹窗"
              message="审计背景仍须扫描"
              onCancel={vi.fn()}
              onConfirm={vi.fn()}
            />
          )}
        </>,
      )
      const group = document.createElement('div')
      group.setAttribute('aria-label', '注入的无效分组')
      group.textContent = '审计变异内容'
      container.append(group)
      await expect(audit(container, '无 role 容器变异')).rejects.toThrow(
        /incomplete.*aria-prohibited-attr/s,
      )
      group.setAttribute('role', 'group')
      await audit(container, '恢复有效分组')
    },
  )

  it('违例守卫：无名称按钮仍被既有 violations 口径阻断', async () => {
    const { container } = render(<button type="button" />)
    await expect(audit(container, '无名称按钮变异')).rejects.toThrow(
      /violation.*button-name/s,
    )
  })
})

describe('无障碍审计（首页与设置页）', () => {
  it('首页正常态：项目卡与工具栏无规则违例', async () => {
    const { container } = render(
      <HomePage
        projects={[project]}
        onOpenProject={vi.fn()}
        onCreateProject={vi.fn()}
        onRenameProject={vi.fn()}
        onDuplicateProject={vi.fn()}
        onDeleteProject={vi.fn()}
      />,
    )
    await audit(container, '首页正常态')
  })

  it('首页错误态：列表读取失败横幅与重试入口无规则违例', async () => {
    const { container } = render(
      <HomePage
        projects={[project]}
        loadError="目录不可读"
        onRetryLoad={vi.fn()}
        onOpenProject={vi.fn()}
        onCreateProject={vi.fn()}
        onRenameProject={vi.fn()}
        onDuplicateProject={vi.fn()}
        onDeleteProject={vi.fn()}
      />,
    )
    await audit(container, '首页错误态')
  })

  it('设置页：Provider 配置与模型表单无规则违例', async () => {
    const { container } = render(<SettingsView onClose={vi.fn()} />)
    // 表单在异步 settingsStore.load() 完成后才挂载：等待就绪态再审计，
    // 避免快照停在「正在加载设置…」占位
    await screen.findByText('OpenAI 兼容')
    await audit(container, '设置页')
  })
})

describe('无障碍审计（首页对话框）', () => {
  it('重命名对话框：输入框标签与操作区无规则违例', async () => {
    const { container } = render(
      <RenameDialog
        currentName="都市奇缘"
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    )
    await audit(container, '重命名对话框')
  })

  it('删除确认对话框：不可逆提示与危险操作按钮无规则违例', async () => {
    const { container } = render(
      <ConfirmDeleteDialog
        title="删除项目"
        message="将永久删除「都市奇缘」及其全部内容，此操作不可撤销。"
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    )
    await audit(container, '删除确认对话框')
  })
})

describe('无障碍审计（编辑器与导出弹窗）', () => {
  it('审计树覆盖守卫：连线与分支选项胶囊真实进入审计 DOM', async () => {
    const { container } = render(
      <EditorView
        project={editorProject}
        onBackHome={vi.fn()}
        onRenameProject={vi.fn()}
        onSave={vi.fn()}
      />,
    )
    // 审计盲区守卫（issue #363）：审计树若不含连线与分支选项胶囊，
    // 画布的连线/端口/胶囊语义就落在 axe 范围之外——本守卫先于任何
    // 违例断言证明「被审计的对象确实在 DOM 里」。
    await awaitCanvasEdges(container)
    expect(container.querySelectorAll('.pw-edge-label').length).toBeGreaterThan(
      0,
    )
    expect(
      container.querySelectorAll('.react-flow__handle').length,
    ).toBeGreaterThan(0)
  })

  it('编辑器装配：标题栏/三栏/真实画布（节点+三类连线+分支胶囊）无规则违例', async () => {
    const { container } = render(
      <EditorView
        project={editorProject}
        onBackHome={vi.fn()}
        onRenameProject={vi.fn()}
        onSave={vi.fn()}
      />,
    )
    await awaitCanvasEdges(container)
    await audit(container, '编辑器装配')
  })

  it('导出弹窗（打开态）：对话框语义与操作区无规则违例', async () => {
    const { container } = render(
      <ExportDialog
        projectName="审计项目"
        json='{"schemaVersion":1}'
        model={exportModel}
        onClose={vi.fn()}
      />,
    )
    await audit(container, '导出弹窗')
    fireEvent.change(screen.getByRole('combobox', { name: '导出格式' }), {
      target: { value: 'json' },
    })
    await audit(container, 'JSON 导出弹窗')
  })
})

describe('无障碍审计（画布浮层与节点表单）', () => {
  it('画布右键菜单（节点形态）：操作项无规则违例', async () => {
    const { container } = render(
      <CanvasContextMenu
        x={120}
        y={140}
        nodeId="scene-3"
        onToggleSettings={vi.fn()}
        onDuplicate={vi.fn()}
        onDeleteNode={vi.fn()}
        onDeleteEdge={vi.fn()}
        onCreate={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    await audit(container, '画布右键菜单（节点形态）')
  })

  it('画布右键菜单（连线形态）：删除连线项无规则违例', async () => {
    const { container } = render(
      <CanvasContextMenu
        x={120}
        y={140}
        edgeId="e-branch1-confess"
        onToggleSettings={vi.fn()}
        onDuplicate={vi.fn()}
        onDeleteNode={vi.fn()}
        onDeleteEdge={vi.fn()}
        onCreate={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    await audit(container, '画布右键菜单（连线形态）')
  })

  it('画布右键菜单（空白形态）：五类新增项无规则违例', async () => {
    const { container } = render(
      <CanvasContextMenu
        x={120}
        y={140}
        onToggleSettings={vi.fn()}
        onDuplicate={vi.fn()}
        onDeleteNode={vi.fn()}
        onDeleteEdge={vi.fn()}
        onCreate={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    await audit(container, '画布右键菜单（空白形态）')
  })

  it.each(panelNodes.map((node) => [node.type, node] as const))(
    '节点设置表单（%s）：字段标签与操作区无规则违例',
    async (_type, node) => {
      const { container } = render(
        <NodeEditContext.Provider value={nodeEditApi}>
          <ImageGenContext.Provider value={imageGenApi}>
            <NodeSettingsPanel node={node} />
          </ImageGenContext.Provider>
        </NodeEditContext.Provider>,
      )
      await audit(container, `节点设置表单（${node.type}）`)
    },
  )

  it('设定文档编辑弹窗：标题/正文字段与关联 chips 无规则违例', async () => {
    render(
      <DocumentEditorDialog
        doc={documentEntity}
        settings={SAMPLE_SETTINGS}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    // 弹窗经 portal 挂在 document.body（避开面板裁剪上下文，见模块头），
    // 不在 render 返回的 container 内——审计整个 body
    await audit(document.body, '设定文档编辑弹窗')
  })
})

describe('无障碍审计（AI 会话与全局降级）', () => {
  it('AI 会话面板（含线程内容）：消息、预览卡与输入区无规则违例', async () => {
    vi.spyOn(settingsStore, 'load').mockResolvedValue(readySettings)
    const { container } = render(
      <EditorView
        project={editorProject}
        onBackHome={vi.fn()}
        onRenameProject={vi.fn()}
        onSave={vi.fn()}
        aiSession={aiSession}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '✦ AI' }))
    // 线程内容覆盖守卫（issue #363）：空线程的审计不覆盖消息与预览卡
    await screen.findByText('给开场补充三条旁白。')
    expect(screen.getByText('已生成三条旁白，请确认。')).toBeTruthy()
    expect(container.querySelectorAll('.pw-ai-card').length).toBeGreaterThan(0)
    await audit(container, 'AI 会话面板（含线程内容）')
  })

  it('崩溃屏：降级界面的错误输出与重载入口无规则违例', async () => {
    // 崩溃是本用例的预期路径：抑制 React 的 console.error 与 jsdom 虚拟
    // 控制台的未捕获报告（后者只认 window error 事件的 preventDefault）
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const swallow = (e: Event) => e.preventDefault()
    window.addEventListener('error', swallow)
    function Boom(): never {
      throw new Error('审计用崩溃')
    }
    const { container } = render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    await screen.findByText('界面出错了')
    window.removeEventListener('error', swallow)
    await audit(container, '崩溃屏')
  })

  it('退出冲刷阻塞横幅：role=alert 诊断无规则违例', async () => {
    const { container } = render(
      <ErrorBanner message="仍有未落盘改动，关闭窗口前会先保存。" />,
    )
    await audit(container, '退出冲刷阻塞横幅')
  })
})
