import { useEffect, useState } from 'react'
import { type NodeProps } from '@xyflow/react'
import { useNodeEdit } from '../nodeEdit'
import { useImageJobs } from '../imagegen/context'
import { projectAssets } from '../projectAssets'
import NodeSettingsPanel from './settings/NodeSettingsPanel'
import type { AssetRef } from '../../model/document'
import type { ImageFlowNode } from './types'

/** 产物图像：项目资产门面解析媒体 URL 懒渲染；解析失败显示可读占位
 * （资产条目在而媒体不可读属异常态——不静默空白，保留可诊断线索）。 */
function OutputImage({
  projectId,
  asset,
}: {
  readonly projectId: string
  readonly asset: AssetRef
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    setFailed(false)
    projectAssets
      .mediaUrl(projectId, asset)
      .then((u) => {
        if (alive) setUrl(u)
      })
      .catch(() => {
        if (alive) setFailed(true)
      })
    return () => {
      alive = false
    }
  }, [projectId, asset])
  if (failed) return <span className="pw-image-empty">产物媒体无法读取（{asset.relPath}）</span>
  if (!url) return null
  return (
    <img
      className="pw-image-out-img"
      src={url}
      alt={asset.relPath}
      onError={() => setFailed(true)}
    />
  )
}

/** 产物区占位文案：悬空引用 / 运行中 / 空态（S3358 独立成函数）。 */
function outputPlaceholder(
  primary: ImageFlowNode['data']['outputs']['primary'],
  running: boolean,
): string {
  if (primary !== undefined) return `产物资产缺失（${primary.assetId}）`
  return running ? '生成中…' : '尚未生成——⚙️ 配置 Prompt 后生成'
}

/**
 * 图片节点 = 生成侧媒体节点（docs/ui-design.md §4.1/数据模型 §13 文生图
 * 首版）。深色石板监视器卡：标题行（IMAGE 徽标 + 尺寸 + 作业状态 + 常驻
 * ⚙️）→ Prompt 预览 → 产物区（生成图像 / 生成中 / 空态 / 悬空引用占位）。
 * 不参与任何连线（自由摆放），无 Handle。
 */
export default function ImageNode({ id, data, selected }: NodeProps<ImageFlowNode>) {
  const { projectId, openSettingsId, toggleSettings, assets } = useNodeEdit()
  const { jobOf } = useImageJobs()
  const job = jobOf(id)
  const settingsOpen = openSettingsId === id
  const primary = data.outputs.primary
  const asset =
    primary !== undefined &&
    assets?.byId !== undefined &&
    Object.prototype.hasOwnProperty.call(assets.byId, primary.assetId)
      ? assets.byId[primary.assetId]
      : undefined

  return (
    <div className={`pw-image${selected ? ' pw-on' : ''}`}>
      <div className="pw-image-tb">
        <span className="pw-image-badge">🖼 IMAGE</span>
        <span className="pw-image-size">{data.size}</span>
        <span className="pw-sp" />
        {job?.status === 'running' && <span className="pw-image-status">生成中…</span>}
        {job?.status === 'error' && (
          <span className="pw-image-status pw-image-status-err" title={job.message}>
            生成失败
          </span>
        )}
        <button
          type="button"
          className={`pw-gear nodrag${settingsOpen ? ' pw-gear-open' : ''}`}
          data-pw-gear
          aria-label="图片节点设置"
          aria-expanded={settingsOpen}
          onClick={(e) => {
            e.stopPropagation()
            toggleSettings(id)
          }}
        >
          ⚙️
        </button>
      </div>
      <p className="pw-image-prompt">{data.prompt !== '' ? data.prompt : '（未填写 Prompt）'}</p>
      <div className="pw-image-out">
        {asset !== undefined ? (
          <OutputImage projectId={projectId} asset={asset} />
        ) : (
          <span className="pw-image-empty">
            {outputPlaceholder(primary, job?.status === 'running')}
          </span>
        )}
      </div>
      {settingsOpen && <NodeSettingsPanel node={{ id, type: 'image', data }} />}
    </div>
  )
}
