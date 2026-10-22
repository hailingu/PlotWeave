// @vitest-environment happy-dom
/** #594：设置防抖失败立即可见，重试复用原保存链，旧完成不虚报恢复。 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SettingsView } from './SettingsView'
import { settingsStore } from './settingsStore'
import { defaultSettings } from './types'

beforeEach(async () => {
  await settingsStore.save(defaultSettings())
})
afterEach(async () => {
  await act(async () => cleanup())
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/** 等真实读取进入 ready 后使用虚拟时钟控制防抖；失败日志是本套件的预期事件。 */
async function setup() {
  const onClose = vi.fn()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  render(<SettingsView onClose={onClose} />)
  await screen.findByText('OpenAI 兼容')
  vi.useFakeTimers()
  const image = screen.getByRole('combobox', { name: /图像生成模型/ })
  const edit = (value: string) => fireEvent.change(image, { target: { value } })
  const advance = () => act(async () => vi.advanceTimersByTimeAsync(500))
  return { onClose, warn, image, edit, advance }
}

it('防抖失败立即可见，重试失败保持草稿，恢复后真实设置可读且不关闭', async () => {
  const save = settingsStore.save.bind(settingsStore)
  const saver = vi
    .spyOn(settingsStore, 'save')
    .mockRejectedValueOnce(new Error('磁盘暂不可写'))
    .mockRejectedValueOnce(new Error('仍然不可写'))
    .mockImplementation(save)
  const { onClose, image, edit, advance } = await setup()
  edit('openai:gpt-4o')
  await advance()
  expect(screen.getByRole('alert').textContent).toContain('磁盘暂不可写')
  expect(onClose).not.toHaveBeenCalled()
  expect((image as HTMLSelectElement).value).toBe('openai:gpt-4o')
  fireEvent.click(screen.getByRole('button', { name: '重试保存' }))
  await act(async () => {})
  expect(screen.getByRole('alert').textContent).toContain('仍然不可写')
  fireEvent.click(screen.getByRole('button', { name: '重试保存' }))
  await act(async () => {})
  expect(screen.queryByRole('alert')).toBeNull()
  expect((await settingsStore.load()).defaultImage).toBe('openai:gpt-4o')
  expect(onClose).not.toHaveBeenCalled()
  expect(saver).toHaveBeenCalledTimes(3)
})

it('旧重试成功时新编辑仍待存，错误保留到最新快照实际落盘', async () => {
  const save = settingsStore.save.bind(settingsStore)
  let finish!: () => void
  let finishLatest!: () => void
  vi.spyOn(settingsStore, 'save')
    .mockRejectedValueOnce(new Error('暂不可写'))
    .mockImplementationOnce(
      (next) =>
        new Promise<void>((resolve) => {
          finish = () => {
            void save(next).then(resolve)
          }
        }),
    )
    .mockImplementationOnce(
      (next) =>
        new Promise<void>((resolve) => {
          finishLatest = () => {
            void save(next).then(resolve)
          }
        }),
    )
    .mockImplementation(save)
  const { edit, advance } = await setup()
  edit('openai:gpt-4o')
  await advance()
  expect(screen.getByRole('alert')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '重试保存' }))
  edit('openai:gpt-4o-mini')
  await act(async () => finish())
  expect(screen.getByRole('alert')).toBeTruthy()
  expect((await settingsStore.load()).defaultImage).toBe('openai:gpt-4o')
  await act(async () => finishLatest())
  expect(screen.queryByRole('alert')).toBeNull()
  expect((await settingsStore.load()).defaultImage).toBe('openai:gpt-4o-mini')
})

it('旧失败不回填覆盖已排队的新编辑，最新保存成功后没有陈旧诊断', async () => {
  const save = settingsStore.save.bind(settingsStore)
  let fail!: (error: Error) => void
  vi.spyOn(settingsStore, 'save')
    .mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => {
          fail = reject
        }),
    )
    .mockImplementation(save)
  const { edit, advance } = await setup()
  edit('openai:gpt-4o')
  await advance()
  edit('openai:gpt-4o-mini')
  await advance()
  await act(async () => fail(new Error('旧保存失败')))
  expect(screen.queryByRole('alert')).toBeNull()
  expect((await settingsStore.load()).defaultImage).toBe('openai:gpt-4o-mini')
})

it('关闭失败后就地重试保存成功，同时清除旧关闭错误并保持页面打开', async () => {
  const save = settingsStore.save.bind(settingsStore)
  vi.spyOn(settingsStore, 'save')
    .mockRejectedValueOnce(new Error('关闭保存失败'))
    .mockImplementation(save)
  const { onClose, edit } = await setup()
  edit('openai:gpt-4o')
  fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))
  await act(async () => {})
  expect(screen.getByRole('alert').textContent).toContain('关闭保存失败')
  fireEvent.click(screen.getByRole('button', { name: '重试保存' }))
  await act(async () => {})
  expect(screen.queryByRole('alert')).toBeNull()
  expect((await settingsStore.load()).defaultImage).toBe('openai:gpt-4o')
  expect(onClose).not.toHaveBeenCalled()
})
