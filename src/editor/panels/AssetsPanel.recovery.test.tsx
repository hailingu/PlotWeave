// @vitest-environment happy-dom
/** #137：通过真实图库门面与 React 面板验证损坏提示和正常资产编辑，仅替换 IPC。 */
import { afterEach, expect, it, vi } from 'vitest'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { invoke } from '@tauri-apps/api/core'
import { AssetsPanel } from './AssetsPanel'

vi.hoisted(() => {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: {},
  })
})
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
})

it('损坏提示可见且可关闭，正常条目仍可编辑；后续操作的新诊断重新显示', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  let saved = {
    id: 'good',
    name: '正常图片',
    kind: 'other',
    mime: 'image/png',
    relPath: 'assets/good.png',
    source: 'upload',
    tags: [] as string[],
    createdAt: '2026-01-01T00:00:00.000Z',
  }
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'list_library_assets')
      return {
        assets: { byId: { good: structuredClone(saved) } },
        warnings: ['条目 bad 已隔离，其余条目可以继续使用'],
      }
    if (command === 'update_library_asset') {
      const { patch } = args as { patch: { tags: string[] } }
      saved = { ...saved, ...patch }
      return { ...saved, warnings: ['损坏部分已替换，原件已保留'] }
    }
    throw new Error(`意外命令：${command}`)
  })
  const firstView = render(<AssetsPanel />)
  await screen.findByRole('status')
  expect(screen.getByText('条目 bad 已隔离，其余条目可以继续使用')).toBeTruthy()
  firstView.unmount()
  render(<AssetsPanel />)
  await waitFor(() =>
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([command]) => command === 'list_library_assets'),
    ).toHaveLength(2),
  )
  expect(screen.getByRole('status').textContent).toContain(
    '图库数据提示（1 项）',
  )
  fireEvent.click(screen.getByRole('button', { name: '关闭图库提示' }))
  expect(screen.queryByRole('status')).toBeNull()
  fireEvent.click(screen.getByTitle('查看其他'))
  const tags = screen.getByLabelText('资产标签 正常图片')
  fireEvent.change(tags, { target: { value: '新标签' } })
  fireEvent.blur(tags)
  await waitFor(() => expect(saved.tags).toEqual(['新标签']))
  await screen.findByRole('status')
  expect(screen.getByText('损坏部分已替换，原件已保留')).toBeTruthy()
  expect(
    screen.getByRole('button', { name: '＋ 导入' }).hasAttribute('disabled'),
  ).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: '关闭图库提示' }))
})
