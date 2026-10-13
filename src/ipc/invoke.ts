/**
 * 类型化宿主 IPC 入口（issue #394 评审 5339899090）：全仓唯一允许绑定
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
import { detectHostKind, type HostKind } from '../platform/hostEnvironment'
import { hasSwiftHostTransport, invokeSwiftHost } from '../platform/swiftHost'

/** 命令传输不可用错误的稳定错误码（界面层据此展示可重试失败）。 */
export const HOST_COMMAND_UNAVAILABLE = 'PW_HOST_COMMAND_UNAVAILABLE'

/** 宿主命令传输尚未接通的结构化失败：命令与宿主类别随错误携带。 */
export class HostCommandUnavailableError extends Error {
  readonly code: string

  constructor(command: IpcCommandName, host: HostKind) {
    super(
      `宿主命令 ${command} 在当前宿主（${host}）尚未接通：原生外壳未提供该能力的传输`,
    )
    this.name = 'HostCommandUnavailableError'
    this.code = HOST_COMMAND_UNAVAILABLE
  }
}

/** 宿主命令传输：命令名 + 参数对象 → 异步结果。 */
export type HostCommandTransport = <T>(
  command: IpcCommandName,
  args?: Record<string, unknown>,
) => Promise<T>

let testTransport: HostCommandTransport | null = null

/** 注入/清除可控测试传输；仅测试代码调用。 */
export function setHostCommandTransportForTests(
  transport: HostCommandTransport | null,
): void {
  testTransport = transport
}

/** 经共享常量执行宿主命令：Swift 走带会话身份的原生桥，其余延迟加载 Tauri。 */
export function ipcInvoke<T = unknown>(
  cmd: IpcCommandName,
  args?: Record<string, unknown>,
): Promise<T> {
  return (async () => {
    if (testTransport !== null) return testTransport<T>(cmd, args)
    const host = detectHostKind()
    if (host === 'swift') {
      if (!hasSwiftHostTransport())
        throw new HostCommandUnavailableError(cmd, host)
      return invokeSwiftHost<T>(cmd, args)
    }
    const { invoke } = await import('@tauri-apps/api/core')
    return args === undefined ? invoke<T>(cmd) : invoke<T>(cmd, args)
  })()
}
