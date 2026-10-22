// @vitest-environment happy-dom
/**
 * App 编辑器重挂载种子域测试（issue #525 自 App.test.tsx 拆分）：设置页
 * 往返后编辑器以带外最新文档/会话为种子（issue #61/#118），画布保存路径
 * 写引用不触发渲染，以及返回首页后带外引用的权威失效边界。
 * issue #542 收敛：两条保存通道（画布文档/AI 会话）的「编辑器子树零次
 * 多余提交」同形断言在此参数化合并（原 AI 通道用例来自
 * App.aiSession.test.tsx，其保存委托断言由 App.test.tsx 回调编排用例持有）。
 * 子视图与 projectStore 桩经 appShellTestScaffolding 委托。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, screen } from '@testing-library/react'
import { App } from './App'
import type { ProjectContent } from './projectStore'
import {
  DOC,
  afterAppShellTest,
  editorProps,
  editorRenders,
  homeProps,
  openEditor,
  resetAppShellFixture,
  saveRevisedDoc,
  settingsRoundtrip,
  store,
} from './appShellTestScaffolding'

vi.mock('./projectStore', async () =>
  (await import('./appShellTestScaffolding')).projectStoreMockModule(),
)
vi.mock('./home/HomePage', async () =>
  (await import('./appShellTestScaffolding')).homePageMockModule(),
)
vi.mock('./editor/EditorView', async () =>
  (await import('./appShellTestScaffolding')).editorViewMockModule(),
)
vi.mock('./settings/SettingsView', async () =>
  (await import('./appShellTestScaffolding')).settingsViewMockModule(),
)

afterEach(afterAppShellTest)

beforeEach(() => resetAppShellFixture())

describe('App ✦设置往返的重挂载种子（issue #118）', () => {
  it('保存落定后设置往返：重挂载种子解析保存路径的最新文档（全字段一致）', async () => {
    const revised = await saveRevisedDoc(App)
    await settingsRoundtrip()
    expect(editorProps.current.project).toEqual({ id: 'p1', ...revised })
  })

  it('保存在途时设置往返：重挂载种子仍为最新文档，不回退打开快照', async () => {
    await openEditor(App)
    let releaseSave: (() => void) | null = null
    // Once 变体：挂起实现不得泄漏到后续用例（clearAllMocks 不清实现）
    store.save.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseSave = resolve
        }),
    )
    const revised = { ...DOC, name: '雨夜·在途' }
    await act(async () => {
      ;(editorProps.current.onSave as (doc: ProjectContent) => Promise<void>)(
        revised,
      ).catch(() => undefined)
    })
    await settingsRoundtrip()
    expect(editorProps.current.project).toEqual({ id: 'p1', ...revised })
    await act(async () => {
      releaseSave?.()
    })
  })

  it('保存失败后设置往返：重挂载种子为内存最新文档（失败不得回退打开快照）', async () => {
    await openEditor(App)
    store.save.mockRejectedValueOnce(new Error('磁盘已满'))
    const revised = { ...DOC, name: '雨夜·未落盘' }
    await act(async () => {
      await expect(
        (editorProps.current.onSave as (doc: ProjectContent) => Promise<void>)(
          revised,
        ),
      ).rejects.toThrow('磁盘已满')
    })
    await settingsRoundtrip()
    expect(editorProps.current.project).toEqual({ id: 'p1', ...revised })
  })

  // issue #542 参数化：仅触发动作（保存通道）不同，断言同形——保存写
  // 带外引用不得令编辑器子树发生任何多余提交。
  it.each(['画布保存路径写带外引用', 'AI 会话消息保存'] as const)(
    '%s：编辑器子树零次多余提交（issue #61）',
    async (channel) => {
      await openEditor(App)
      const rendersBefore = editorRenders.count
      await act(async () => {
        if (channel === '画布保存路径写带外引用') {
          await (
            editorProps.current.onSave as (doc: ProjectContent) => Promise<void>
          )(structuredClone(DOC))
        } else {
          const session = {
            schemaVersion: 1 as const,
            entries: [{ id: 1, kind: 'note' as const, text: '新消息' }],
          }
          await (
            editorProps.current.onSaveAiSession as (
              value: typeof session,
            ) => Promise<void>
          )(session)
        }
      })
      expect(editorRenders.count).toBe(rendersBefore)
    },
  )
})

describe('App ✦设置往返的引用边界（issue #118）', () => {
  it('返回首页清除带外文档：重开项目以磁盘载入为准，旧引用不得胜出', async () => {
    const revised = await saveRevisedDoc(App)
    await act(async () => {
      ;(editorProps.current.onBackHome as () => void)()
    })
    await screen.findByTestId('home')
    await act(async () => {
      await (homeProps.current.onOpenProject as (id: string) => Promise<void>)(
        'p1',
      )
    })
    await screen.findByTestId('editor')
    // load 桩固定返回打开快照：带外引用已清除，磁盘载入结果胜出
    expect(editorProps.current.project).toEqual({
      id: 'p1',
      ...structuredClone(DOC),
    })
    expect(editorProps.current.project).not.toEqual({ id: 'p1', ...revised })
  })

  it('首次保存后改名：重挂载种子同步改名，旧名称不得回退（issue #118 评审）', async () => {
    await openEditor(App)
    await act(async () => {
      await (
        editorProps.current.onSave as (doc: ProjectContent) => Promise<void>
      )(structuredClone(DOC))
    })
    act(() => {
      ;(editorProps.current.onRenameProject as (name: string) => void)(
        '雨夜·修订',
      )
    })
    expect((editorProps.current.project as { name: string }).name).toBe(
      '雨夜·修订',
    )
  })

  it('返回首页后卸载冲刷复活的引用不得在重开时胜出（issue #118 评审）', async () => {
    await openEditor(App)
    // 真实编辑器卸载冲刷经此闭包在返回首页后把最新文档交回 onSave
    const staleOnSave = editorProps.current.onSave as (
      doc: ProjectContent,
    ) => Promise<void>
    await act(async () => {
      ;(editorProps.current.onBackHome as () => void)()
    })
    await screen.findByTestId('home')
    await act(async () => {
      await staleOnSave({ ...structuredClone(DOC), name: '冲刷交付' })
    })
    // 首页改名后重开：load 桩返回改名后的文档，复活的引用不得胜出
    store.load.mockResolvedValue({ ...structuredClone(DOC), name: '首页改名' })
    await act(async () => {
      await (homeProps.current.onOpenProject as (id: string) => Promise<void>)(
        'p1',
      )
    })
    await screen.findByTestId('editor')
    expect((editorProps.current.project as { name: string }).name).toBe(
      '首页改名',
    )
  })
})
