// @vitest-environment happy-dom
/** 浏览器运行环境的退出边界（issue #473）：不加载原生 SDK 或注册屏障。 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useExitFlush } from './useExitFlush'

// 越过浏览器守门即加载失败，钩子会外显初始化诊断；替身只拦截外部 SDK。
vi.mock('@tauri-apps/api/window', () => {
  throw new Error('浏览器不得加载原生窗口模块')
})
vi.mock('@tauri-apps/api/event', () => {
  throw new Error('浏览器不得加载原生事件模块')
})
vi.mock('@tauri-apps/api/core', () => {
  throw new Error('浏览器不得加载原生 IPC 模块')
})

afterEach(cleanup)

/** 将真实钩子的可见阻断状态呈现在 DOM 上。 */
function Probe() {
  const blocked = useExitFlush()
  return <output>{blocked ?? '浏览器可正常关闭'}</output>
}

it('浏览器挂载退出钩子后无需原生关闭屏障，也没有初始化失败诊断', async () => {
  render(<Probe />)
  await vi.dynamicImportSettled()
  expect(screen.getByText('浏览器可正常关闭')).toBeTruthy()
})
