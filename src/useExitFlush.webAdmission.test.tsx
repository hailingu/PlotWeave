// @vitest-environment happy-dom
/** 最终退出回执在途时，实际文档 owner 必须停止接纳新持久化状态。 */
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useExitFlush } from './useExitFlush'
import { useEditorDocument } from './editor/useEditorDocument'
import { EMPTY_SETTINGS } from './editor/settings'
import { useState } from 'react'
import { defaultSettings } from './settings/types'
import { useSettingsSaver } from './settings/useSettingsSaver'
import { hasPendingSettingsSaves } from './settings/settingsSaveRegistry'

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, '__pwNativeHost')
  Reflect.deleteProperty(window, 'webkit')
})

it('干净页面最终批准在途时，画布新编辑明确拒绝且内容保持', async () => {
  let release!: () => void
  const approval = new Promise<void>((resolve) => {
    release = resolve
  })
  let awaitingApproval = false
  Object.assign(window, {
    __pwNativeHost: {
      kind: 'swift',
      protocolVersion: 1,
      sessionId: 'web-exit-admission',
    },
    webkit: {
      messageHandlers: {
        plotweaveHost: {
          postMessage: async ({ command }: { command: string }) => {
            if (command === 'app_exit') {
              awaitingApproval = true
              await approval
            }
            return { ok: null }
          },
        },
      },
    },
  })
  const view = renderHook(() => {
    useExitFlush()
    const doc = useEditorDocument({
      id: 'web-owned-project',
      name: '项目',
      nodes: [],
      edges: [],
      settings: EMPTY_SETTINGS,
      episodeTitles: { 1: '已保存' },
    })
    const [settings, setSettings] = useState(defaultSettings)
    const saver = useSettingsSaver(setSettings, () => {})
    return { ...doc, settingsSnapshot: settings, updateSettings: saver.update }
  })
  await act(async () => {
    await Promise.resolve()
  })
  const host = window as Window & {
    __pwDispatchHostEvent?: (name: string, payload: unknown) => void
  }
  host.__pwDispatchHostEvent?.('app-quit-requested', null)
  await vi.waitFor(() => expect(awaitingApproval).toBe(true))
  try {
    act(() => {
      expect(() =>
        view.result.current.setEpisodeTitles({ 1: '退出窗口新稿' }),
      ).toThrow(/PW_WEB_EXIT_PENDING/)
      expect(() => view.result.current.setAiRevision(1)).toThrow(
        /PW_WEB_EXIT_PENDING/,
      )
      expect(() =>
        view.result.current.updateViewport({ x: 12, y: 8, zoom: 1 }),
      ).toThrow(/PW_WEB_EXIT_PENDING/)
      expect(() =>
        view.result.current.updateSettings({
          ...view.result.current.settingsSnapshot,
          defaultChat: 'new:model',
        }),
      ).toThrow(/PW_WEB_EXIT_PENDING/)
    })
    expect(view.result.current.episodeTitles).toEqual({ 1: '已保存' })
    expect(view.result.current.aiRevision).toBe(0)
    expect(view.result.current.viewport).toBeUndefined()
    expect(view.result.current.settingsSnapshot.defaultChat).toBeNull()
    expect(hasPendingSettingsSaves()).toBe(false)
  } finally {
    await act(async () => {
      release()
      await approval
    })
  }
})
