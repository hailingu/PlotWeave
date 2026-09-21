// @vitest-environment jsdom
/**
 * 自动无障碍审计（issue #238）：axe-core 规则扫描覆盖首页（正常/错误态）、
 * 设置页、导出弹窗与编辑器（真实 React Flow 画布装配）。违例输出可定位
 * 诊断：规则 id、影响、帮助文案、触发选择器与规则文档链接。
 * 已禁用规则与不可覆盖项（披露）：color-contrast 依赖真实渲染引擎的样式
 * 计算，合成 DOM 中结果不可信，禁用并保留人工验收；自动扫描亦不覆盖
 * 真实 WebView 行为与屏幕阅读器播报（见 PR 说明）。
 */
import { cleanup, render, screen } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HomePage } from './home/HomePage'
import type { ProjectSummary } from './home/projects'
import { SettingsView } from './settings/SettingsView'
import { settingsStore } from './settings/settingsStore'
import { defaultSettings } from './settings/types'
import { ExportDialog } from './editor/ExportDialog'
import type { ScriptExportModel } from './editor/exportScript'
import { EditorView } from './editor/EditorView'
import type { EditorProjectContent } from './editor/useEditorDocument'
import type { CanvasNode } from './editor/nodes/types'

afterEach(cleanup)

// jsdom 不提供 ResizeObserver（happy-dom 内建），真实画布装配需要它；
// 审计只读 DOM 结构，桩为无操作即可
if (typeof ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}
// 同因：jsdom 的 HTMLElement 无 scrollTo（AI 线程挂载滚动到最新条目）
if (typeof HTMLElement.prototype.scrollTo !== 'function') {
  HTMLElement.prototype.scrollTo = (() => {}) as unknown as () => void
}

beforeEach(async () => {
  // 设置页内存 store 是模块级单例：每例前重置，避免相邻用例串扰
  await settingsStore.save(defaultSettings())
})

/** 对渲染容器执行 axe 规则扫描，违例格式化为可定位诊断后清零断言。 */
async function audit(container: HTMLElement, context: string) {
  const results = await axe.run(container, {
    rules: {
      // 视觉对比度需真实样式计算（合成 DOM 无样式渲染），结果不可信：
      // 禁用并保留人工验收（issue #238 验收说明）
      'color-contrast': { enabled: false },
    },
  })
  const lines = results.violations.map(
    (v) =>
      `${v.id}（${v.impact ?? '未分级'}）：${v.help}｜触点 ${v.nodes
        .map((n) => n.target.join(' '))
        .join(' ; ')}｜${v.helpUrl}`,
  )
  expect(lines, `${context} 存在可访问性规则违例`).toEqual([])
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

const sceneNode = {
  id: 'sc1',
  type: 'scene',
  position: { x: 0, y: 0 },
  data: {
    name: '天台',
    sceneNo: 1,
    interior: false,
    time: '夜',
    synopsis: '开场',
    characterIds: [],
  },
} as unknown as CanvasNode

const editorProject: EditorProjectContent = {
  id: 'p1',
  name: '审计项目',
  nodes: [sceneNode],
  edges: [],
  settings: { characters: [], locations: [] },
}

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

describe('无障碍审计（编辑器与导出弹窗）', () => {
  it('编辑器装配：标题栏/三栏/真实画布无规则违例', async () => {
    const { container } = render(
      <EditorView
        project={editorProject}
        onBackHome={vi.fn()}
        onRenameProject={vi.fn()}
        onSave={vi.fn()}
      />,
    )
    await audit(container, '编辑器装配')
  })

  it('导出弹窗（打开态）：对话框语义与操作区无规则违例', async () => {
    const { container } = render(
      <ExportDialog
        projectName="审计项目"
        model={exportModel}
        onClose={vi.fn()}
      />,
    )
    await audit(container, '导出弹窗')
  })
})
