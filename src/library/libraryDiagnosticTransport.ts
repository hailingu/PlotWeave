/** 图库响应与恢复事件共用的 IPC 诊断边界；数据模型 §7.2 定义信封与序号。 */
import { isNativeHost } from '../platform/hostEnvironment'
import { listenHostEvent } from '../platform/hostEvents'
import {
  publishCleanupPending,
  publishLibraryWarnings,
} from './libraryDiagnostics'
import { createDiagnostic } from '../diagnostics'

/** 失败事件显式绑定级别、域与机器码；旧前缀和上下文原样交付。 */
const logEvents = {
  libraryIndexEntryQuarantined: createDiagnostic(
    'WARN',
    'plotweave::frontend::library',
    'LIBRARY_INDEX_ENTRY_QUARANTINED',
  ),
  libraryCleanupPending: createDiagnostic(
    'WARN',
    'plotweave::frontend::library',
    'LIBRARY_CLEANUP_PENDING',
  ),
  libraryDiagnosticsListenerFailed: createDiagnostic(
    'ERROR',
    'plotweave::frontend::library',
    'LIBRARY_DIAGNOSTICS_LISTENER_FAILED',
  ),
}

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
        logEvents.libraryIndexEntryQuarantined(
          '[Library] 索引条目隔离：',
          warning,
        )
    }
  }
  const pending = result.cleanupPending
  if (pending === undefined && result.diagnosticsRevision === undefined) return
  publishCleanupPending(pending, result.diagnosticsRevision)
  if (Array.isArray(pending) && pending.length > 0)
    logEvents.libraryCleanupPending('[Library] 删除隔离区待清理：', pending)
}

/** 应用启动屏障：库读取/拷贝恢复事件必须在首个组件请求之前可接收。
 * 监听失败仍允许编辑，但诊断完整性未知，保守暂停本会话的目录清理指引。
 * 监听覆盖整个前端会话；返回清理函数供入口在页面会话结束时释放。 */
export async function initializeLibraryDiagnostics(): Promise<
  (() => void) | undefined
> {
  if (!isNativeHost()) return
  try {
    return await listenHostEvent<unknown>('library-diagnostics', (payload) => {
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
    logEvents.libraryDiagnosticsListenerFailed('[Library] 实时诊断监听失败', {
      code: 'LIBRARY_DIAGNOSTICS_LISTENER_FAILED',
      error,
    })
    publishLibraryWarnings([
      '图库实时诊断监听失败，请重新启动应用后再核对清理状态',
    ])
  }
}
