/** 图库损坏/隔离信息的非阻塞展示，不接管正常资产的编辑和导入能力。 */
import { useSyncExternalStore } from 'react'
import {
  cleanupPendingSnapshot,
  dismissLibraryWarnings,
  libraryWarningsSnapshot,
  subscribeLibraryWarnings,
} from '../../library/libraryDiagnostics'

/** 展示可展开的诊断详情，并允许用户关闭已读提示。 */
export function LibraryWarnings() {
  const warnings = useSyncExternalStore(
    subscribeLibraryWarnings,
    libraryWarningsSnapshot,
  )
  const pending = useSyncExternalStore(
    subscribeLibraryWarnings,
    cleanupPendingSnapshot,
  )
  if (warnings.length === 0 && pending.length === 0) return null
  return (
    <div className="pw-assets-hint">
      {warnings.length > 0 && (
        <details>
          <summary>
            <output>图库数据提示（{warnings.length} 项）</output>
          </summary>
          {warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </details>
      )}
      {pending.length > 0 && (
        <details>
          <summary>
            <output>删除隔离区待清理（{pending.length} 项）</output>
          </summary>
          <p>
            磁盘空间尚未释放——当前平台缺少安全清理能力，不会自动删除这些文件；删除完成仅指图库不再引用，不代表空间已回收。
          </p>
          <p>
            恢复方式：在应用完全退出后，删除应用数据目录下
            library/assets/.trash/ 中的内容，并同步移除
            library/asset-delete-journal.json
            中的对应条目后重启。请勿改动目录下其他文件。
          </p>
          {pending.map((item) => (
            <p key={item}>{item}</p>
          ))}
        </details>
      )}
      <button type="button" onClick={dismissLibraryWarnings}>
        关闭图库提示
      </button>
    </div>
  )
}
