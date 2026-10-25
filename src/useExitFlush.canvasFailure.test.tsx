// @vitest-environment happy-dom
/** #849：真实画布保存 owner 的失败不能依赖项目重试登记才能阻断退出。 */
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useDebouncedSave } from './editor/useDebouncedSave'
import { useExitFlush } from './useExitFlush'
import { hasPendingCanvasSaves } from './canvasSaveRegistry'
import { isWebExitPending } from './webExitFence'
import type { ProjectContent } from './model/content'
import { enqueueSave } from './projectStore/saveChain'
import { registerSettingsFlushGate } from './settings/settingsSaveRegistry'

const native = vi.hoisted(() => ({
  close: undefined as
    undefined | ((event: { preventDefault: () => void }) => Promise<void>),
  quit: undefined as undefined | ((event: { payload: null }) => void),
  destroy: vi.fn(async () => undefined),
  invoke: vi.fn<
    (command: string, args?: Record<string, unknown>) => Promise<null>
  >(async () => null),
}))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    destroy: native.destroy,
    onCloseRequested: async (handler: typeof native.close) => {
      native.close = handler
      return () => {
        native.close = undefined
      }
    },
  }),
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (
    _name: string,
    handler: (event: { payload: null }) => void,
  ) => {
    native.quit = handler
    return () => {
      native.quit = undefined
    }
  },
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }))

const roots: string[] = []
const registrations: Array<() => void> = []
afterEach(async () => {
  cleanup()
  registrations.splice(0).forEach((unregister) => unregister())
  for (const key of ['__TAURI_INTERNALS__', '__pwNativeHost', 'webkit'])
    Reflect.deleteProperty(window, key)
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
  vi.clearAllMocks()
  native.invoke.mockReset().mockResolvedValue(null)
  vi.restoreAllMocks()
})

/** 分别走 Tauri 窗口关闭、宿主退出事件与 Swift 带会话回执的原生桥。 */
function installHost(entry: string) {
  if (entry !== 'swift-quit') {
    Object.assign(window, { __TAURI_INTERNALS__: {} })
    return
  }
  Object.assign(window, {
    __pwNativeHost: {
      kind: 'swift',
      protocolVersion: 1,
      sessionId: 'canvas-failure',
    },
    webkit: {
      messageHandlers: {
        plotweaveHost: {
          postMessage: async ({
            command,
            args,
          }: {
            command: string
            args?: Record<string, unknown>
          }) => {
            await native.invoke(command, args)
            return { ok: null }
          },
        },
      },
    },
  })
}

/** 一次用户退出意图；等待完整微任务链，由真实 owner 交付失败或批准结果。 */
async function requestExit(entry: string) {
  const event = { preventDefault: vi.fn() }
  await act(async () => {
    if (entry === 'tauri-close') await native.close?.(event)
    else if (entry === 'tauri-quit') native.quit?.({ payload: null })
    else {
      const host = window as Window & {
        __pwDispatchHostEvent?: (name: string, payload: unknown) => void
      }
      host.__pwDispatchHostEvent?.('app-quit-requested', null)
    }
  })
  if (entry === 'tauri-close') expect(event.preventDefault).toHaveBeenCalled()
}

/** 用真实临时文件验证保存恢复；错误码注入不改变系统或测试目录权限。 */
async function saveFixture(failure: string) {
  const root = await mkdtemp(join(tmpdir(), 'pw-canvas-exit-'))
  roots.push(root)
  const file = join(root, 'project.json')
  if (failure === 'EISDIR') await mkdir(file)
  let failing = true
  let attempts = 0
  const save = vi.fn(async (doc: ProjectContent) => {
    attempts += 1
    // 旧实现会无限重试；第三次解除夹具故障仅作为熔断，下面仍要求首次退出恰好保存一次。
    if (failing && attempts <= 2) {
      if (failure !== 'EISDIR')
        throw Object.assign(new Error(failure), { code: failure })
      await writeFile(file, JSON.stringify(doc))
    }
    if (failure === 'EISDIR') await rm(file, { recursive: true, force: true })
    await writeFile(file, JSON.stringify(doc))
  })
  return {
    save,
    file,
    recover: () => {
      failing = false
    },
  }
}

const initial: ProjectContent = {
  name: '已保存',
  nodes: [],
  edges: [],
  settings: { characters: [], locations: [] },
}

/** 只把实际批准 app_exit 的调用计为退出，Swift cancel 回执单独验证。 */
function approvals() {
  return native.invoke.mock.calls.filter(
    ([command, args]) => command === 'app_exit' && args?.cancel !== true,
  )
}

const cases = ['tauri-close', 'tauri-quit', 'swift-quit'].flatMap((entry) =>
  ['ENOSPC', 'EROFS', 'EISDIR'].map((failure) => ({ entry, failure })),
)
it.each(cases)(
  '$entry：$failure 画布失败同轮阻断，恢复后最新编辑真实落盘',
  async ({ entry, failure }) => {
    installHost(entry)
    const { save, file, recover } = await saveFixture(failure)
    const view = renderHook(() => {
      const blocked = useExitFlush()
      const saver = useDebouncedSave(initial, save, 60_000)
      return { ...saver, blocked }
    })
    await vi.waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith(
        'acknowledge_quit_listener',
        ...(entry === 'swift-quit' ? [undefined] : []),
      ),
    )
    act(() => view.result.current.markDirty({ ...initial, name: '未落盘编辑' }))
    await requestExit(entry)
    await vi.waitFor(() =>
      expect(view.result.current.blocked).toContain('已阻止退出'),
    )
    expect(view.result.current.blocked).toContain('画布保存失败')
    expect(save).toHaveBeenCalledTimes(1)
    expect(view.result.current.saveStatus).toBe('failed')
    expect(hasPendingCanvasSaves()).toBe(true)
    expect(native.destroy).not.toHaveBeenCalled()
    expect(approvals()).toEqual([])
    if (entry === 'swift-quit') {
      await vi.waitFor(() =>
        expect(native.invoke).toHaveBeenCalledWith('app_exit', {
          cancel: true,
        }),
      )
      expect(isWebExitPending()).toBe(false)
      expect(document.body.inert).not.toBe(true)
    }
    recover()
    act(() =>
      view.result.current.markDirty({ ...initial, name: '恢复后的最新编辑' }),
    )
    await requestExit(entry)
    await vi.waitFor(() => expect(view.result.current.blocked).toBeNull())
    expect(hasPendingCanvasSaves()).toBe(false)
    expect(JSON.parse(await readFile(file, 'utf8')).name).toBe(
      '恢复后的最新编辑',
    )
    if (entry === 'tauri-close') expect(native.destroy).toHaveBeenCalledTimes(1)
    else expect(approvals()).toHaveLength(1)
  },
)

it.each(
  ['tauri-quit', 'swift-quit'].flatMap((entry) =>
    [false, true].map((lateEdit) => ({ entry, lateEdit })),
  ),
)(
  '$entry：同轮项目重试成功后 lateEdit=$lateEdit，不误阻断新工作',
  async ({ entry, lateEdit }) => {
    installHost(entry)
    const { file } = await saveFixture('ENOSPC')
    let writes = 0
    native.invoke.mockImplementation(async (command, args) => {
      if (command === 'save_project') {
        if (++writes === 1) throw new Error('ENOSPC')
        await writeFile(file, JSON.stringify(args?.doc))
      }
      return null
    })
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
    const view = renderHook(() => ({
      blocked: useExitFlush(),
      ...useDebouncedSave(
        initial,
        (doc) => enqueueSave('retry-849', doc),
        60_000,
      ),
    }))
    await vi.waitFor(() =>
      expect(
        native.invoke.mock.calls.some(
          ([command]) => command === 'acknowledge_quit_listener',
        ),
      ).toBe(true),
    )
    let rounds = 0
    const unregister = registerSettingsFlushGate({
      hasPending: () => false,
      flush: async () => {
        if (++rounds === 1 && lateEdit)
          view.result.current.markDirty({ ...initial, name: '重试后的新编辑' })
      },
    })
    registrations.push(unregister)
    act(() =>
      view.result.current.markDirty({ ...initial, name: '由重试持久化' }),
    )
    await requestExit(entry)
    await vi.waitFor(() => expect(approvals()).toHaveLength(1))
    expect(writes).toBe(lateEdit ? 3 : 2)
    unregister()
    expect(diagnostic).toHaveBeenCalledTimes(1)
    expect(view.result.current.blocked).toBeNull()
    expect(hasPendingCanvasSaves()).toBe(false)
    expect(JSON.parse(await readFile(file, 'utf8')).project.name).toBe(
      lateEdit ? '重试后的新编辑' : '由重试持久化',
    )
  },
)

it.each(['tauri-quit', 'swift-quit'])(
  '%s：画布冲刷成功后新编辑进入下一轮，不能误报失败',
  async (entry) => {
    installHost(entry)
    const { save, file, recover } = await saveFixture('ENOSPC')
    recover()
    const view = renderHook(() => ({
      blocked: useExitFlush(),
      ...useDebouncedSave(initial, save, 60_000),
    }))
    let rounds = 0
    const unregister = registerSettingsFlushGate({
      hasPending: () => false,
      flush: async () => {
        if (++rounds === 1)
          view.result.current.markDirty({ ...initial, name: '冲刷中的新编辑' })
      },
    })
    try {
      await vi.waitFor(() =>
        expect(
          native.invoke.mock.calls.some(
            ([command]) => command === 'acknowledge_quit_listener',
          ),
        ).toBe(true),
      )
      act(() =>
        view.result.current.markDirty({ ...initial, name: '第一轮编辑' }),
      )
      await requestExit(entry)
      await vi.waitFor(() => expect(approvals()).toHaveLength(1))
      expect(save).toHaveBeenCalledTimes(2)
      expect(rounds).toBe(2)
      expect(view.result.current.blocked).toBeNull()
      expect(JSON.parse(await readFile(file, 'utf8')).name).toBe(
        '冲刷中的新编辑',
      )
    } finally {
      unregister()
    }
  },
)
