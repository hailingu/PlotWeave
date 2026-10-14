import { expect, vi, type MockInstance } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentType, ReactNode } from 'react'
import type { ProjectContent } from './projectStore'

/**
 * App 壳层测试的共享脚手架（issue #525 拆分 App.test.tsx 时收敛）：
 * projectStore/HomePage/EditorView/SettingsView 的桩模块工厂、props
 * 捕获与监听器登记区、DOC 夹具、beforeEach 复位与打开/设置往返等共享
 * 辅助函数，原在各功能域测试文件逐字复制。按 issue #311 的归类决定与
 * 测试同目录放置并登记为测试设施（sonar-project.properties 的「源码
 * 排除 + 测试纳入」组合、vite 覆盖率 exclude，契约由
 * scripts/sonar-test-scope.test.ts 守卫）：不进生产 bundle，仍被
 * Sonar 按测试代码分析；导入者只能是测试文件或测试设施。
 *
 * vi.mock 工厂被 Vitest 提升到 import 之前执行，只能引用 vi 与动态
 * import，各测试文件经下列模式委托本模块：
 *
 * vi.mock('./projectStore', async () =>
 *   (await import('./appShellTestScaffolding')).projectStoreMockModule(),
 * )
 *
 * 因此本模块不得在运行期导入 './App' 或 './projectStore'：工厂经动态
 * import 触发本模块求值时，若本模块再静态导入 App →（被桩的）
 * projectStore，会与在途的桩工厂互相等待成环。渲染类辅助函数经参数
 * 接收 App 组件（openEditor(App)）；store 桩句柄由本模块自建的 vi.fn
 * 集合导出。
 */

/** 子视图最近一次的 props（回调经此触发，断言经此读参）。 */
export const homeProps: { current: Record<string, unknown> } = { current: {} }
export const editorProps: { current: Record<string, unknown> } = {
  current: {},
}
/** EditorView 桩的累计渲染次数（issue #61：保存不得重渲染编辑器子树）。 */
export const editorRenders = { count: 0 }

/** 编辑器挂起门（PR #110 评审并发用例）：promise 非空时编辑器子树抛出
 * 该 Promise 令过渡停在 chunk 加载态、首页保持可交互——模拟真实 lazy
 * chunk 的排队导航提交窗口。仅并发用例设置，复位函数清空。 */
export const editorSuspendGate: { promise: Promise<void> | null } = {
  promise: null,
}

/** projectStore.onAiSessionSaved 已登记的监听器（测试经此模拟退出重试成功）。 */
export const retrySavedListeners: Array<(id: string) => void> = []
/** projectStore.onProjectSaved 已登记的监听器（测试经此模拟画布保存落定，issue #101）。 */
export const savedListeners: Array<(id: string) => void> = []
/** projectStore.onAiSessionSaveFailed 已登记的监听器（测试经此模拟回吐重排失败）。 */
export const replayFailedListeners: Array<
  (id: string, event: { session: unknown; error: string }) => void
> = []

/** projectStore 桩的 store 方法句柄：工厂把它们装进 mock 模块，测试经此
 * 编排 resolved/rejected 值并断言调用。 */
const storeMocks = {
  list: vi.fn(),
  create: vi.fn(),
  load: vi.fn(),
  loadAiSession: vi.fn(),
  saveAiSession: vi.fn(),
  save: vi.fn(),
  duplicate: vi.fn(),
  delete: vi.fn(),
}
export const store = storeMocks

/** vi.mock('./projectStore') 的委托工厂：监听器登记进共享数组，方法桩
 * 与导出的 store 句柄同源。 */
export function projectStoreMockModule() {
  return {
    projectStore: {
      ...storeMocks,
      onAiSessionSaved: (listener: (id: string) => void) => {
        retrySavedListeners.push(listener)
        return () => {
          const index = retrySavedListeners.indexOf(listener)
          if (index >= 0) retrySavedListeners.splice(index, 1)
        }
      },
      onProjectSaved: (listener: (id: string) => void) => {
        savedListeners.push(listener)
        return () => {
          const index = savedListeners.indexOf(listener)
          if (index >= 0) savedListeners.splice(index, 1)
        }
      },
      onAiSessionSaveFailed: (
        listener: (
          id: string,
          event: { session: unknown; error: string },
        ) => void,
      ) => {
        replayFailedListeners.push(listener)
        return () => {
          const index = replayFailedListeners.indexOf(listener)
          if (index >= 0) replayFailedListeners.splice(index, 1)
        }
      },
    },
  }
}

/** vi.mock('./home/HomePage') 的委托工厂：捕获 props 并渲染可断言的
 * 首页摘要、打开/变更失败警示与重试入口。 */
export function homePageMockModule() {
  return {
    HomePage: (props: Record<string, unknown>): ReactNode => {
      homeProps.current = props
      const openError = props.openError as { detail: string } | null | undefined
      const mutationError = props.mutationError as
        | {
            action: string
            targetId?: string
            targetName?: string
            detail: string
          }
        | null
        | undefined
      return (
        <div data-testid="home">
          {props.loading
            ? '加载中'
            : `共${(props.projects as unknown[]).length}项`}
          {openError ? <div role="alert">{openError.detail}</div> : null}
          {mutationError ? (
            <div role="alert">
              {`${mutationError.action}:${mutationError.targetName ?? mutationError.targetId ?? ''}:${mutationError.detail}`}
              {props.onRetryMutation ? (
                <button
                  type="button"
                  data-testid="retry-mutation"
                  onClick={props.onRetryMutation as () => void}
                >
                  重试
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      )
    },
  }
}

/** vi.mock('./editor/EditorView') 的委托工厂：捕获 props、计入渲染次数，
 * 挂起门非空时抛出 promise 模拟 chunk 未就绪。 */
export function editorViewMockModule() {
  return {
    EditorView: (props: Record<string, unknown>): ReactNode => {
      if (editorSuspendGate.promise) throw editorSuspendGate.promise
      editorProps.current = props
      editorRenders.count += 1
      return (
        <div data-testid="editor">
          {(props.project as { name: string }).name}
        </div>
      )
    },
  }
}

/** vi.mock('./settings/SettingsView') 的委托工厂：关闭按钮即 onClose。 */
export function settingsViewMockModule() {
  return {
    SettingsView: (props: { onClose: () => void }): ReactNode => (
      <button type="button" data-testid="settings" onClick={props.onClose}>
        设置
      </button>
    ),
  }
}

/** 各用例共享的落盘文档夹具；需隔离修改时以 structuredClone 复制。 */
export const DOC: ProjectContent = {
  name: '雨夜',
  nodes: [],
  edges: [],
  settings: { characters: [], locations: [] },
}

/** console.warn 静默 spy 的共享句柄（issue #542 收敛）：安装与恢复由
 * resetAppShellFixture / afterAppShellTest 的每用例生命周期负责，替代
 * 此前散落各域用例的局部 spyOn/mockRestore 对；需断言告警是否发生的
 * 用例经此读取。 */
export const consoleWarn: { spy: MockInstance<typeof console.warn> | null } = {
  spy: null,
}

/** 本用例是否已声明预期 console.warn（PR #567 评审：静默不得无条件
 * 覆盖名义路径用例，否则意外告警的回归信号被吞）。 */
let consoleWarnExpected = false

/** 声明本用例预期触发 console.warn（失败路径用例）：告警仍被静默，
 * 但收尾不再因告警判失败。预期失败路径的用例以此替代局部 spy。 */
export function expectConsoleWarn(): void {
  consoleWarnExpected = true
}

/** 恢复在位的静默 spy 后重新安装；正常生命周期下复位时无在位 spy，
 * 防御性恢复仅为复位被重复调用时不叠加包装。 */
function silenceConsoleWarn(): void {
  consoleWarnExpected = false
  consoleWarn.spy?.mockRestore()
  consoleWarn.spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
}

/** 每用例收尾：卸载 React 树；未声明预期而触发 console.warn 的用例
 * 如实失败并回放告警内容（PR #567 评审：不得无条件丢弃诊断），随后
 * 恢复被静默的 console.warn。各域测试文件以此替代裸 afterEach(cleanup)。 */
export function afterAppShellTest(): void {
  cleanup()
  const spy = consoleWarn.spy
  if (!consoleWarnExpected && spy && spy.mock.calls.length > 0) {
    const replay = spy.mock.calls
      .map((args) => args.map((arg) => String(arg)).join(' '))
      .join('\n')
    spy.mockRestore()
    consoleWarn.spy = null
    throw new Error(
      'Unexpected console.warn (declare expectConsoleWarn() if this is an expected failure path):\n' +
        replay,
    )
  }
  spy?.mockRestore()
  consoleWarn.spy = null
}

/** 每用例复位：清桩调用记录、挂起门与监听器，重建 store 默认应答
 * （load 每次返回全新克隆，防用例间经共享对象串改），并安装
 * console.warn 静默 spy（issue #542）。 */
export function resetAppShellFixture(): void {
  vi.clearAllMocks()
  editorRenders.count = 0
  editorSuspendGate.promise = null
  retrySavedListeners.length = 0
  savedListeners.length = 0
  replayFailedListeners.length = 0
  store.list.mockResolvedValue([{ id: 'p1', name: '雨夜' }])
  store.create.mockResolvedValue({ id: 'new-1', name: '未命名短剧' })
  store.duplicate.mockResolvedValue({ id: 'copy-1', name: '雨夜 副本' })
  store.load.mockResolvedValue(structuredClone(DOC))
  store.loadAiSession.mockResolvedValue({
    session: { schemaVersion: 1, entries: [] },
    repairError: null,
  })
  silenceConsoleWarn()
}

/** 打开 p1 并等编辑器就绪（App 经参数传入：本模块不导入 './App'）。 */
export async function openEditor(App: ComponentType) {
  render(<App />)
  await screen.findByTestId('home')
  await act(async () => {
    await (homeProps.current.onOpenProject as (id: string) => Promise<void>)(
      'p1',
    )
  })
  await screen.findByTestId('editor')
}

/** ⌘, 打开设置页再关闭，触发编辑器重挂载。 */
export async function settingsRoundtrip() {
  fireEvent.keyDown(document, { key: ',', metaKey: true })
  await screen.findByTestId('settings')
  fireEvent.click(screen.getByTestId('settings'))
  await screen.findByTestId('editor')
}

/** 打开项目并保存一份全字段变更文档，返回该文档供种子断言
 * （issue #118 套件共享；置于脚手架以守 describe 回调 80 行上限）。 */
export async function saveRevisedDoc(App: ComponentType) {
  await openEditor(App)
  const revised: ProjectContent = {
    ...DOC,
    name: '雨夜·二稿',
    nodes: [
      {
        id: 'n1',
        type: 'scene',
        position: { x: 0, y: 0 },
        data: {
          name: '开场',
          sceneNo: 1,
          interior: false,
          time: '夜',
          synopsis: '雨夜出租车',
          characterIds: [],
        },
      },
    ],
    edges: [{ id: 'e1', source: 'n1', target: 'n1' }],
    settings: { characters: [], locations: [] },
    episodeTitles: { 1: '第一集' },
    viewport: { x: 12, y: 34, zoom: 1.25 },
    aiRevision: 3,
    assets: {
      byId: {
        a1: {
          id: 'a1',
          relPath: 'projects/p1/assets/a1.wav',
          mime: 'audio/wav',
          source: 'upload',
          createdAt: '2026-09-14T00:00:00.000Z',
        },
      },
    },
  }
  await act(async () => {
    await (
      editorProps.current.onSave as (doc: ProjectContent) => Promise<void>
    )(structuredClone(revised))
  })
  return revised
}

/** 打开项目并等待结果落定（openError 已写入或编辑器已挂载）。 */
export async function attemptOpen(id: string) {
  await act(async () => {
    await (homeProps.current.onOpenProject as (id: string) => Promise<void>)(id)
  })
}

/** 准备真实反馈状态并返回交给保存边界的文档身份，供恢复事件精确匹配。 */
export async function failHomeRename(App: ComponentType) {
  store.save.mockRejectedValueOnce(new Error('暂时只读'))
  render(<App />)
  await screen.findByText('共1项')
  await act(async () => {
    await (
      homeProps.current.onRenameProject as (
        id: string,
        name: string,
      ) => Promise<void>
    )('p1', '新名')
  })
  expect(screen.getByRole('alert').textContent).toMatch(/rename:新名:暂时只读/)
  return store.save.mock.lastCall![1] as ProjectContent
}
