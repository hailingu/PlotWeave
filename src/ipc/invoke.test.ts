/**
 * 类型化入口的转发契约（issue #394 评审 5339899090）：ipcInvoke 原样把
 * 命令名与参数递给 @tauri-apps/api/core 的 invoke；args 省略时以单参
 * 调用（不显式传 undefined）——mock 侧观测到的调用元数与迁移前各调用点
 * 直接持有 invoke 时完全一致。简单顺序流下 vi.mock(core) 拦截稳定；
 * 保存重试级联下的拦截失稳属 vitest 4 对集中式动态导入的 mock 注册表
 * 行为，编排型集成测试（projectStore.tauri、useHomeActionFeedback）因此
 * 改在 ipcInvoke 入口拦截，见各测试文件。
 */
import { describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { IPC_COMMANDS } from './commands'
import { ipcInvoke } from './invoke'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args?: unknown) => ({ cmd, args })),
}))

describe('ipcInvoke 转发契约', () => {
  it('命令名与参数原样转发', async () => {
    await ipcInvoke(IPC_COMMANDS.savePrefs, { prefs: { a: 1 } })
    expect(invoke).toHaveBeenCalledWith('save_prefs', { prefs: { a: 1 } })
  })

  it('args 省略时以单参转发，不显式传 undefined', async () => {
    await ipcInvoke(IPC_COMMANDS.loadPrefs)
    expect(invoke).toHaveBeenCalledWith('load_prefs')
  })
})
