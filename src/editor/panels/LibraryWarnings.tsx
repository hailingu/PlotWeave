/** 图库损坏/隔离信息的非阻塞展示，不接管正常资产的编辑和导入能力。 */
import { useSyncExternalStore } from 'react'
import {
  cleanupPendingSnapshot,
  dismissLibraryWarnings,
  libraryWarningsSnapshot,
  partitionCleanupPending,
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
  // P1（PR #222 评审）：已提交删除的待释放项与冲突/待核对的证据保留项
  // 分区呈现——证据项绝不附删除指引
  const { routine, evidence } = partitionCleanupPending(pending)
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
      {routine.length > 0 && (
        <details>
          <summary>
            <output>删除隔离区待清理（{routine.length} 项）</output>
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
          {routine.map((item) => (
            <p key={item}>{item}</p>
          ))}
        </details>
      )}
      {evidence.length > 0 && (
        <details>
          <summary>
            <output>待人工核对的删除事务（{evidence.length} 项）</output>
          </summary>
          <p>
            这些事务的媒体与日志被特意保留为恢复与核对证据（身份不符、被占用或索引不确定），不是可释放的空间——请勿删除
            library/assets/.trash/ 内容或 asset-delete-journal.json
            条目，否则可能永久丢失仅存的原媒体。
          </p>
          <p>
            请先备份再人工核对（规则见数据模型
            §7.2）；核对完成前相关资产保持不可用。
          </p>
          {evidence.map((item) => (
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
