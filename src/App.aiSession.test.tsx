// @vitest-environment happy-dom
/**
 * App AI 会话域测试（issue #525 自 App.test.tsx 拆分）：会话恢复的损坏
 * 隔离与读取失败边界、保存通道的成功/失败/在途路径（issue #61）、退出
 * 重试成功通知与回吐重排失败的事件登记恢复（issue #47 历轮评审）。
 * 子视图与 projectStore 桩经 appShellTestScaffolding 委托。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, screen } from '@testing-library/react'
import { App } from './App'
import type { ProjectContent } from './projectStore'
import {
  DOC,
  editorProps,
  editorRenders,
  homeProps,
  openEditor,
  replayFailedListeners,
  resetAppShellFixture,
  retrySavedListeners,
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

afterEach(cleanup)

beforeEach(() => resetAppShellFixture())

describe('App ✦AI 会话恢复', () => {
  it('AI 会话文件损坏时仍打开画布，并将恢复错误交给编辑器提示', async () => {
    store.loadAiSession.mockRejectedValue(new Error('AI 会话文件损坏'))
    await openEditor(App)
    expect(editorProps.current.aiSessionError).toContain('AI 会话文件损坏')
    // 读取失败的空回退会话不可作为挂载重试的落盘内容
    expect(editorProps.current.aiSessionRetryable).toBe(false)
  })

  it('AI 会话坏条目隔离后保留可用历史，提示且不自动写回', async () => {
    const recovered = {
      schemaVersion: 1 as const,
      entries: [{ id: 1, kind: 'note' as const, text: '已恢复' }],
    }
    store.loadAiSession.mockResolvedValue({
      session: recovered,
      repairError: 'Error: 只读目录',
    })
    await openEditor(App)
    expect(editorProps.current.aiSession).toEqual(recovered)
    expect(editorProps.current.aiSessionError).toBe('Error: 只读目录')
    // 读取仅展示损坏诊断，不触发挂载保存。
    expect(editorProps.current.aiSessionRetryable).toBe(false)
  })
})

describe('App ✦AI 会话保存', () => {
  it('追加 AI 消息保存成功：编辑器子树零次多余提交（issue #61）', async () => {
    await openEditor(App)
    const rendersBefore = editorRenders.count
    const session = {
      schemaVersion: 1 as const,
      entries: [{ id: 1, kind: 'note' as const, text: '新消息' }],
    }
    await act(async () => {
      await (
        editorProps.current.onSaveAiSession as (
          value: typeof session,
        ) => Promise<void>
      )(session)
    })
    expect(store.saveAiSession).toHaveBeenCalledWith('p1', session)
    expect(editorRenders.count).toBe(rendersBefore)
  })

  it('有加载诊断后实际编辑并保存成功：项目级错误清除，重挂载不再报保存失败', async () => {
    const recovered = {
      schemaVersion: 1 as const,
      entries: [{ id: 1, kind: 'note' as const, text: '已恢复' }],
    }
    store.loadAiSession.mockResolvedValue({
      session: recovered,
      repairError: 'Error: 只读目录',
    })
    store.saveAiSession.mockResolvedValue(undefined)
    await openEditor(App)
    expect(editorProps.current.aiSessionError).toBe('Error: 只读目录')
    const session = {
      schemaVersion: 1 as const,
      entries: [
        ...recovered.entries,
        { id: 2, kind: 'note' as const, text: '新历史' },
      ],
    }
    await (
      editorProps.current.onSaveAiSession as (
        value: typeof session,
      ) => Promise<void>
    )(session)
    await settingsRoundtrip()
    expect(editorProps.current.aiSession).toEqual(session)
    expect(editorProps.current.aiSessionError).toBeNull()
  })

  it('从设置返回时保留本次打开后新增的 AI 会话历史', async () => {
    await openEditor(App)
    const session = {
      schemaVersion: 1 as const,
      entries: [{ id: 1, kind: 'note' as const, text: '新的历史' }],
    }
    await (
      editorProps.current.onSaveAiSession as (
        value: typeof session,
      ) => Promise<void>
    )(session)
    await settingsRoundtrip()
    expect(editorProps.current.aiSession).toEqual(session)
  })
})

describe('App ✦AI 会话保存失败', () => {
  it('正常加载后用户变更会话：保存失败仍保留内容并允许重试', async () => {
    store.saveAiSession.mockRejectedValueOnce(new Error('磁盘已满'))
    await openEditor(App)
    expect(editorProps.current.aiSessionRetryable).toBe(false)
    const changed = {
      schemaVersion: 1 as const,
      entries: [{ id: 1, kind: 'note' as const, text: '用户的新消息' }],
    }
    await act(async () => {
      await expect(
        (
          editorProps.current.onSaveAiSession as (
            value: typeof changed,
          ) => Promise<void>
        )(changed),
      ).rejects.toThrow('磁盘已满')
    })
    expect(editorProps.current.aiSession).toEqual(changed)
    // 成功加载后的会话变更保留在内存，可重试保存。
    expect(editorProps.current.aiSessionRetryable).toBe(true)
  })

  it('会话保存失败时拒绝上浮，错误写入项目级：重挂载不丢警告', async () => {
    store.saveAiSession.mockRejectedValueOnce(new Error('磁盘已满'))
    await openEditor(App)
    const session = {
      schemaVersion: 1 as const,
      entries: [{ id: 1, kind: 'note' as const, text: '未落盘' }],
    }
    await act(async () => {
      await expect(
        (
          editorProps.current.onSaveAiSession as (
            value: typeof session,
          ) => Promise<void>
        )(session),
      ).rejects.toThrow('磁盘已满')
    })
    expect(editorProps.current.aiSession).toEqual(session)
    expect(editorProps.current.aiSessionError).toContain('磁盘已满')
    await settingsRoundtrip()
    expect(editorProps.current.aiSessionError).toContain('磁盘已满')
  })

  it('保存失败后回首页再重开：未落盘会话保留并标记可重试', async () => {
    await openEditor(App)
    const changed = {
      schemaVersion: 1 as const,
      entries: [{ id: 1, kind: 'note' as const, text: '未落盘' }],
    }
    store.saveAiSession.mockRejectedValueOnce(new Error('磁盘已满'))
    await act(async () => {
      await expect(
        (
          editorProps.current.onSaveAiSession as (
            value: typeof changed,
          ) => Promise<void>
        )(changed),
      ).rejects.toThrow('磁盘已满')
    })
    await act(async () => {
      ;(editorProps.current.onBackHome as () => void)()
    })
    expect(await screen.findByTestId('home')).toBeTruthy()
    // 重开同一项目：磁盘上是旧会话，但内存保留的未落盘会话胜出并标记可重试
    await act(async () => {
      await (homeProps.current.onOpenProject as (id: string) => Promise<void>)(
        'p1',
      )
    })
    await screen.findByTestId('editor')
    expect(editorProps.current.aiSession).toEqual(changed)
    expect(editorProps.current.aiSessionError).toContain('磁盘已满')
    expect(editorProps.current.aiSessionRetryable).toBe(true)
  })
})

describe('App ✦AI 会话重试成功通知', () => {
  it('退出重试补写成功：清除项目级错误与保留快照，重开不再以内存会话胜出', async () => {
    store.saveAiSession.mockRejectedValueOnce(new Error('磁盘已满'))
    await openEditor(App)
    const changed = {
      schemaVersion: 1 as const,
      entries: [{ id: 1, kind: 'note' as const, text: '未落盘' }],
    }
    await act(async () => {
      await expect(
        (
          editorProps.current.onSaveAiSession as (
            value: typeof changed,
          ) => Promise<void>
        )(changed),
      ).rejects.toThrow('磁盘已满')
    })
    expect(editorProps.current.aiSessionError).toContain('磁盘已满')

    await act(async () => {
      retrySavedListeners.forEach((notify) => notify('p1'))
    })
    expect(editorProps.current.aiSessionError).toBeNull()

    // 保留快照已清：回首页重开走磁盘载入，不再以内存保留会话胜出
    await act(async () => {
      ;(editorProps.current.onBackHome as () => void)()
    })
    expect(await screen.findByTestId('home')).toBeTruthy()
    store.loadAiSession.mockClear()
    await act(async () => {
      await (homeProps.current.onOpenProject as (id: string) => Promise<void>)(
        'p1',
      )
    })
    await screen.findByTestId('editor')
    expect(store.loadAiSession).toHaveBeenCalledTimes(1)
  })

  it('通知只清除对应项目：别的项目错误不受影响', async () => {
    await openEditor(App)
    // 经项目级状态注入另一项目的错误（onSaveAiSession 只作用于打开项目）
    const changed = { schemaVersion: 1 as const, entries: [] }
    // 打开项目的错误由保存失败产生
    store.saveAiSession.mockRejectedValueOnce(new Error('磁盘已满'))
    await act(async () => {
      await expect(
        (
          editorProps.current.onSaveAiSession as (
            value: typeof changed,
          ) => Promise<void>
        )(changed),
      ).rejects.toThrow('磁盘已满')
    })
    await act(async () => {
      retrySavedListeners.forEach((notify) => notify('other-project'))
    })
    expect(editorProps.current.aiSessionError).toContain('磁盘已满')
  })
})

describe('App ✦AI 会话保存失败（在途）', () => {
  it('保存在途时重开项目：保留区在加载屏障之后读取，拒绝晚到仍命中', async () => {
    await openEditor(App)
    let rejectSave!: (err: Error) => void
    store.saveAiSession.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectSave = reject
        }),
    )
    const changed = {
      schemaVersion: 1 as const,
      entries: [{ id: 1, kind: 'note' as const, text: '在途未落盘' }],
    }
    await act(async () => {
      ;(
        editorProps.current.onSaveAiSession as (
          value: typeof changed,
        ) => Promise<void>
      )(changed).catch(() => undefined)
    })
    await act(async () => {
      ;(editorProps.current.onBackHome as () => void)()
    })
    expect(await screen.findByTestId('home')).toBeTruthy()

    // 重开：load 挂起期间保存拒绝落定（保留区在屏障内被写入）
    let releaseLoad!: (doc: ProjectContent) => void
    store.load.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseLoad = resolve
        }),
    )
    await act(async () => {
      ;(homeProps.current.onOpenProject as (id: string) => Promise<void>)('p1')
      rejectSave(new Error('磁盘已满'))
    })
    await act(async () => {
      releaseLoad(structuredClone(DOC))
    })

    await screen.findByTestId('editor')
    expect(editorProps.current.aiSession).toEqual(changed)
    expect(editorProps.current.aiSessionError).toContain('磁盘已满')
    expect(editorProps.current.aiSessionRetryable).toBe(true)
  })
})

describe('App 会话读取失败边界', () => {
  it('读取失败禁用 AI，画布继续打开；重开读取成功后解除', async () => {
    const history = {
      schemaVersion: 1,
      entries: [{ id: 1, kind: 'note', text: '原有历史' }],
    }
    store.loadAiSession.mockResolvedValue({
      session: history,
      repairError: null,
    })
    store.loadAiSession.mockRejectedValueOnce(new Error('临时读取失败'))
    await openEditor(App)
    expect(editorProps.current.aiSessionLoadFailed).toBe(true)
    expect(editorProps.current.project).toBeTruthy()
    await settingsRoundtrip()
    expect(editorProps.current.aiSessionLoadFailed).toBe(true)
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
    expect(editorProps.current.aiSessionLoadFailed).toBe(false)
    expect(editorProps.current.aiSession).toEqual(history)
    expect(store.saveAiSession).not.toHaveBeenCalled()
  })
})

describe('App ✦AI 会话回吐重排失败恢复', () => {
  it('墓碑吸收的会话补写失败：事件登记恢复快照，重开内存副本胜出并提示可重试', async () => {
    await openEditor(App)
    const retained = {
      schemaVersion: 1 as const,
      entries: [{ id: 1, kind: 'note' as const, text: '墓碑期消息' }],
    }
    // 删除失败回吐重排失败：原始保存已被吸收为成功，失败只能经事件上浮
    await act(async () => {
      replayFailedListeners.forEach((listener) =>
        listener('p1', { session: retained, error: 'Error: 磁盘仍满' }),
      )
    })
    await act(async () => {
      ;(editorProps.current.onBackHome as () => void)()
    })
    expect(await screen.findByTestId('home')).toBeTruthy()
    // 重开同一项目：磁盘是旧会话，事件登记的恢复快照胜出并提示可重试
    await act(async () => {
      await (homeProps.current.onOpenProject as (id: string) => Promise<void>)(
        'p1',
      )
    })
    await screen.findByTestId('editor')
    expect(editorProps.current.aiSession).toEqual(retained)
    expect(editorProps.current.aiSessionError).toContain('磁盘仍满')
    expect(editorProps.current.aiSessionRetryable).toBe(true)
  })
})
