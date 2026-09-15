/**
 * 宿主命令传输（P2 宿主接口收敛；迁移计划 §2.3/§4.1，矩阵 M16）：各 store
 * 的 Rust 命令调用统一入口，取代散落的 `await import('@tauri-apps/api/core')`
 * 直调。
 * - swift：原生外壳的命令传输尚未接通（P2 后续项落 Rust FFI 桥），拒绝并
 *   携带稳定错误码——可见失败，不返回假成功（§4.1）。
 * - 其余宿主（tauri，及误达传输的纯浏览器——内存回退守卫在门面层，走到
 *   传输即缺陷）：动态导入 `@tauri-apps/api/core` 并 invoke，保持浏览器
 *   预览不预载 Tauri 模块、误达时由 invoke 自身可见报错（与收敛前一致），
 *   既有 `.tauri.test.ts` 的 vi.mock 截击继续生效。
 * 测试可用 setHostCommandTransportForTests 注入可控传输（§2.3 可控测试实现）。
 */
import { detectHostKind, type HostKind } from './hostEnvironment'

/** 命令传输不可用错误的稳定错误码（界面层据此展示可重试失败）。 */
export const HOST_COMMAND_UNAVAILABLE = 'PW_HOST_COMMAND_UNAVAILABLE'

/** 宿主命令传输尚未接通的结构化失败：命令与宿主类别随错误携带。 */
export class HostCommandUnavailableError extends Error {
  readonly code: string

  constructor(command: string, host: HostKind) {
    super(
      `宿主命令 ${command} 在当前宿主（${host}）尚未接通：原生外壳未提供该能力的传输`,
    )
    this.name = 'HostCommandUnavailableError'
    this.code = HOST_COMMAND_UNAVAILABLE
  }
}

/** 宿主命令传输：命令名 + 参数对象 → 异步结果。 */
export type HostCommandTransport = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>

let testTransport: HostCommandTransport | null = null

/** 注入/清除可控测试传输；仅测试代码调用。 */
export function setHostCommandTransportForTests(
  transport: HostCommandTransport | null,
): void {
  testTransport = transport
}

/** tauri 模块句柄：首次解析即缓存——与 ESM 模块单例语义一致，后续调用
 * 复用同一 Promise，不重复解析（也让测试 mock 只需截获首次动态导入）。 */
let tauriModule: Promise<typeof import('@tauri-apps/api/core')> | null = null

/** 经当前宿主传输执行一条命令：swift 宿主可见失败，其余走 tauri 传输。 */
export async function hostInvoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (testTransport !== null) return testTransport<T>(command, args)
  const host = detectHostKind()
  if (host === 'swift') {
    throw new HostCommandUnavailableError(command, host)
  }
  tauriModule ??= import('@tauri-apps/api/core')
  const { invoke } = await tauriModule
  // args 缺省不传：保持与既有直调完全一致的调用形状（测试按参数计数断言）
  return args === undefined ? invoke<T>(command) : invoke<T>(command, args)
}
