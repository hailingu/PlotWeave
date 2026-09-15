import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  HostCommandTransport,
  HostCommandUnavailableError,
} from './hostCommands'

/**
 * 平台命令传输（docs/swiftui-react-flow-migration-plan.md §2.3/§4.1、矩阵
 * M16）：非 swift 宿主命令与载荷原样路由到 `@tauri-apps/api/core` invoke
 * （vi.doMock 截获动态导入，与既有 `.tauri.test.ts` 同款）；swift 宿主以
 * 稳定错误码可见失败（原生外壳尚未接通该传输，不返回假成功）。内存回退
 * 守卫在门面层：纯浏览器误达传输时由 invoke 自身可见报错，不静默成功。
 */

const invoke = vi.fn(async (cmd: string, args?: unknown) => ({ cmd, args }))

beforeEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
  invoke.mockClear()
})

const load = () => import('./hostCommands')

describe('hostInvoke 宿主路由', () => {
  it('tauri：命令与载荷原样透传 invoke，返回值直通', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    vi.doMock('@tauri-apps/api/core', () => ({ invoke }))
    const { hostInvoke } = await load()
    await expect(hostInvoke('list_projects', { id: 'p1' })).resolves.toEqual({
      cmd: 'list_projects',
      args: { id: 'p1' },
    })
    expect(invoke).toHaveBeenCalledWith('list_projects', { id: 'p1' })
  })

  it('browser（误达传输）：同样路由 tauri 通道，报错形态由 invoke 自身决定', async () => {
    vi.stubGlobal('window', {})
    vi.doMock('@tauri-apps/api/core', () => ({ invoke }))
    const { hostInvoke } = await load()
    await expect(hostInvoke('save_prefs', {})).resolves.toEqual({
      cmd: 'save_prefs',
      args: {},
    })
    expect(invoke).toHaveBeenCalledWith('save_prefs', {})
  })

  it('swift：拒绝为 HostCommandUnavailableError，携带稳定错误码与命令名', async () => {
    vi.stubGlobal('window', { __pwNativeHost: { kind: 'swift' } })
    const { hostInvoke, HostCommandUnavailableError: Err } = await load()
    const err: HostCommandUnavailableError = await hostInvoke(
      'load_prefs',
    ).then(
      () => {
        throw new Error('swift 宿主不得成功')
      },
      (e: unknown) => e as HostCommandUnavailableError,
    )
    expect(err).toBeInstanceOf(Err)
    expect(err.code).toBe('PW_HOST_COMMAND_UNAVAILABLE')
    expect(err.message).toContain('load_prefs')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('测试传输：注入后接管路由并收到命令与载荷，清除后回到宿主探测', async () => {
    vi.stubGlobal('window', {})
    vi.doMock('@tauri-apps/api/core', () => ({ invoke }))
    const { hostInvoke, setHostCommandTransportForTests } = await load()
    // 可控测试传输按 HostCommandTransport 断言调用记录；实现体无需读参
    const fake = vi.fn(async () => 'fake-ok')
    setHostCommandTransportForTests(fake as unknown as HostCommandTransport)
    await expect(hostInvoke('anything', { x: 1 })).resolves.toBe('fake-ok')
    expect(fake).toHaveBeenCalledWith('anything', { x: 1 })
    setHostCommandTransportForTests(null)
    await expect(hostInvoke('anything')).resolves.toEqual({
      cmd: 'anything',
      args: undefined,
    })
    expect(invoke).toHaveBeenCalledWith('anything')
  })
})
