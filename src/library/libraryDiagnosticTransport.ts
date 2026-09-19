/** 图库响应与恢复事件共用的 IPC 诊断边界；数据模型 §7.2 定义信封与序号。 */
import {
  publishCleanupPending,
  publishLibraryWarnings,
} from './libraryDiagnostics'

/** 警告始终保留并写诊断日志，待清理快照独立按后端序号收敛。
 * 不携带诊断的响应不清除旧状态；显式快照缺少有效序号时记录错误。 */
export function reportLibraryDiagnostics(input: unknown): void {
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    return
  const result = input as Record<string, unknown>
  publishLibraryWarnings(result.warnings)
  if (Array.isArray(result.warnings)) {
    for (const warning of result.warnings) {
      if (typeof warning === 'string' && warning !== '')
        console.warn('[Library] 索引条目隔离：', warning)
    }
  }
  const pending = result.cleanupPending
  if (pending === undefined && result.diagnosticsRevision === undefined) return
  publishCleanupPending(pending, result.diagnosticsRevision)
  if (Array.isArray(pending) && pending.length > 0)
    console.warn('[Library] 删除隔离区待清理：', pending)
}

/** 应用启动屏障：库读取/拷贝恢复事件必须在首个组件请求之前可接收。
 * 监听失败仍允许编辑，但诊断完整性未知，保守暂停本会话的目录清理指引。
 * 监听覆盖整个前端会话；返回清理函数供入口在页面会话结束时释放。 */
export async function initializeLibraryDiagnostics(): Promise<
  (() => void) | undefined
> {
  if (!('__TAURI_INTERNALS__' in window)) return
  try {
    const { listen } = await import('@tauri-apps/api/event')
    return await listen<unknown>('library-diagnostics', ({ payload }) => {
      if (
        payload === null ||
        typeof payload !== 'object' ||
        Array.isArray(payload)
      ) {
        publishCleanupPending(undefined, undefined)
        return
      }
      reportLibraryDiagnostics(payload)
    })
  } catch (error) {
    console.error('[Library] 实时诊断监听失败', {
      code: 'LIBRARY_DIAGNOSTICS_LISTENER_FAILED',
      error,
    })
    publishLibraryWarnings([
      '图库实时诊断监听失败，请重新启动应用后再核对清理状态',
    ])
  }
}
