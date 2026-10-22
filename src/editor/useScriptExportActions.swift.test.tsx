// @vitest-environment happy-dom
/** 原生导出/复制只有系统回执才完成，取消和陈旧操作不能伪造成功。 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useScriptExportActions } from './useScriptExportActions'

let postMessage = vi.fn()
beforeEach(() => {
  postMessage = vi.fn().mockResolvedValue({ ok: null })
  Object.assign(window, {
    __pwNativeHost: {
      kind: 'swift',
      protocolVersion: 1,
      sessionId: 'export-session',
    },
    webkit: { messageHandlers: { plotweaveHost: { postMessage } } },
  })
})
afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, '__pwNativeHost')
  Reflect.deleteProperty(window, 'webkit')
})

it('复制交给原生系统服务并等待成功回执', async () => {
  const view = renderHook(() =>
    useScriptExportActions('剧本正文', '项目-剧本', 'md'),
  )
  await act(async () => {
    await view.result.current.copyAll()
  })
  expect(view.result.current.copied).toBe(true)
  expect(postMessage.mock.calls[0]?.[0]).toMatchObject({
    command: 'system.copyText',
    args: { text: '剧本正文' },
  })
})

it('系统保存取消可见且使用当前格式文件名', async () => {
  postMessage.mockResolvedValue({ ok: { cancelled: true } })
  const view = renderHook(() =>
    useScriptExportActions('{}', '项目-剧本', 'json'),
  )
  await act(async () => {
    await view.result.current.download()
  })
  expect(view.result.current.downloadError).toBe('已取消保存')
  expect(postMessage.mock.calls[0]?.[0]).toMatchObject({
    command: 'system.saveText',
    args: { text: '{}', fileName: '项目-剧本.json' },
  })
})

it('旧保存面板回执不覆盖切换格式后的当前状态', async () => {
  let reply!: (result: unknown) => void
  postMessage.mockReturnValue(
    new Promise((resolve) => {
      reply = resolve
    }),
  )
  const view = renderHook(
    ({ format }: { format: 'md' | 'json' }) =>
      useScriptExportActions('text', 'name', format),
    { initialProps: { format: 'md' } },
  )
  void view.result.current.download()
  view.rerender({ format: 'json' })
  await act(async () => {
    reply({ ok: { cancelled: true } })
    await Promise.resolve()
  })
  expect(view.result.current.downloadError).toBeNull()
})

it('系统保存失败和非法回执可见，不报告成功', async () => {
  postMessage.mockResolvedValue({
    error: { code: 'PW_SAVE_IO', message: 'disk failed' },
  })
  const view = renderHook(() => useScriptExportActions('text', 'name', 'md'))
  await act(async () => {
    await view.result.current.download()
  })
  expect(view.result.current.downloadError).toContain('disk failed')
  postMessage.mockResolvedValue({ ok: {} })
  await act(async () => {
    await view.result.current.download()
  })
  expect(view.result.current.downloadError).toContain('回执不符合协议')
})

it('复制拒绝或旧变体迟到成功均不显示已复制', async () => {
  postMessage.mockResolvedValue({
    error: { code: 'PW_COPY_FAILED', message: 'unavailable' },
  })
  const view = renderHook(
    ({ text }) => useScriptExportActions(text, 'name', 'md'),
    { initialProps: { text: 'old' } },
  )
  await act(async () => {
    await view.result.current.copyAll()
  })
  expect(view.result.current.copied).toBe(false)
  let reply!: (result: unknown) => void
  postMessage.mockReturnValue(
    new Promise((resolve) => {
      reply = resolve
    }),
  )
  let copy!: Promise<void>
  act(() => {
    copy = view.result.current.copyAll()
  })
  view.rerender({ text: 'next' })
  await act(async () => {
    reply({ ok: null })
    await copy
  })
  expect(view.result.current.copied).toBe(false)
})
