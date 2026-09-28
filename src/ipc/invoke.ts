/**
 * 类型化 IPC 直调入口（issue #394 评审 5339899090）：全仓唯一允许绑定
 * `@tauri-apps/api/core` 原始 `invoke` 的维护模块。cmd 收窄为
 * IpcCommandName（IPC_COMMANDS 值联合）——调用点写字符串字面量、经变量
 * 中转（`const cmd = '…'; ipcInvoke(cmd)`）或别名导入本包装，都无法让
 * 未注册命令名通过编译期；守卫（commands.test.ts）的排他性断言据此把
 * 「callee 拼写匹配」升级为「说明符出现位置」：任何其他维护模块静态或
 * 动态 import '@tauri-apps/api/core' 即失败——别名/解构/Promise.all/
 * .then 等一切绑定形态都必写该说明符，无从绕过。
 *
 * 动态导入在函数体内执行：浏览器预览不触发调用即不加载 Tauri 模块，
 * 与迁移前各调用点的守门方式等价；args 省略时以单参调用转发（不显式传
 * undefined），mock 侧观测到的调用元数与迁移前完全一致。包装的转发语义
 * 由 src/ipc/invoke.test.ts 直接覆盖；编排 IPC 行为的集成测试改为在本
 * 入口处拦截（如 projectStore.tauri.test.ts、useHomeActionFeedback）。
 */
import type { IpcCommandName } from './commands'

/** 经共享常量类型化地调用 Tauri 命令；args 省略与显式传参同义。 */
export function ipcInvoke<T = unknown>(
  cmd: IpcCommandName,
  args?: Record<string, unknown>,
): Promise<T> {
  return (async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    return args === undefined ? invoke<T>(cmd) : invoke<T>(cmd, args)
  })()
}
