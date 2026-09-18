/** 图库损坏/隔离信息的非阻塞展示，不接管正常资产的编辑和导入能力。 */
import { useSyncExternalStore } from 'react'
import {
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
  if (warnings.length === 0) return null
  return (
    <div className="pw-assets-hint">
      <details>
        <summary>
          <output>图库数据提示（{warnings.length} 项）</output>
        </summary>
        {warnings.map((warning) => (
          <p key={warning}>{warning}</p>
        ))}
      </details>
      <button type="button" onClick={dismissLibraryWarnings}>
        关闭图库提示
      </button>
    </div>
  )
}
