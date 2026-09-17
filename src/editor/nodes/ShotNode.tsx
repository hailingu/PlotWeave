import { useEffect, useState } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { useNodeEdit } from '../nodeEdit'
import { projectAssets } from '../projectAssets'
import { NodeSettingsPanel } from './settings/NodeSettingsPanel'
import { NodeSettingsGear } from './settings/NodeSettingsGear'
import type { AssetRef } from '../../model/document'
import type { ShotFlowNode } from './types'

/** 引用位 chip 的图标：角色垫图 / 场景底图 / 音频。 */
const REF_ICONS = { character: '👤', location: '🏞', audio: '🎵' } as const

/** 引用位缩略图（§8.1）：image/* 资产经项目资产门面解析媒体 URL 懒渲染；
 * 解析失败/非图片不渲染图，chip 回退纯文本。生命周期（issue #131）：
 * 换绑即清旧预览——读取在途或失败都不得以旧资产的图冒充当前引用
 *（alt 已是新资产，图文错配即「A 冒充 B」）；失败以 ⚠ 标记可定位
 *（title 带 relPath），img 加载/解码失败同款转失败态。
 * 换绑的清理时点（PR #197 评审）：调用方以 asset.id 作 key 重挂载本
 * 组件——初始态（无图）随首帧提交，不依赖 passive effect（其晚于
 * 绘制，会让旧 url 多画一帧冒充新引用）；effect 内清空仅兜底 projectId
 * 原位变化等无重挂载路径。 */
function RefThumb({
  projectId,
  asset,
}: {
  readonly projectId: string
  readonly asset: AssetRef
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const assetId = asset.id
  useEffect(() => {
    let alive = true
    setUrl(null)
    setFailed(false)
    projectAssets
      .mediaUrl(projectId, assetId)
      .then((u) => {
        if (alive) setUrl(u)
      })
      .catch(() => {
        if (alive) setFailed(true)
      })
    return () => {
      alive = false
    }
  }, [projectId, assetId])
  if (failed)
    return (
      <span
        className="pw-shot-ref-broken"
        title={`媒体不可读（${asset.relPath}）`}
      >
        ⚠
      </span>
    )
  if (!url) return null
  return (
    <img
      className="pw-shot-ref-thumb"
      src={url}
      alt={asset.relPath}
      onError={() => setFailed(true)}
    />
  )
}

/**
 * 分镜卡 = 监视器卡（docs/ui-design.md §4.2，生成侧深色石板，双外观恒定）。
 * 一张卡 = 一个镜头及其 AI 燃料：镜号 + 景别标题行（常驻 ⚙️）、
 * 画面描述、镜头 Prompt、垫图/底图/音频引用位。
 * 从属关系走顶部入口：宿主索引卡底部端口垂直下挂（§4.4 attach 边）。
 * ⚙️ 打开设置面板（§4.3，编辑即命令）；镜号标题行不设内联改名。
 */
export function ShotNode({ id, data, selected }: NodeProps<ShotFlowNode>) {
  const { projectId, openSettingsId, toggleSettings, assets } = useNodeEdit()
  const settingsOpen = openSettingsId === id

  /** 引用位显示名（§8.1）：自由位显示手填文案；引用位回退 assetId 供辨认
   *（image/* 资产另渲染缩略图）。 */
  const refText = (ref: ShotFlowNode['data']['refs'][number]): string =>
    ref.label ?? ref.assetId ?? ''

  return (
    <div className={`pw-shot${selected ? ' pw-on' : ''}`}>
      <div className="pw-shot-tb">
        <span className="pw-shot-no">
          SHOT {String(data.shotNo).padStart(2, '0')}
        </span>
        <span className="pw-shot-size">{data.size}</span>
        <span className="pw-sp" />
        <NodeSettingsGear
          ariaLabel="分镜设置"
          open={settingsOpen}
          onToggle={() => toggleSettings(id)}
        />
      </div>
      <p className="pw-shot-picture">{data.picture}</p>
      <div className="pw-shot-prompt">
        <span className="pw-shot-prompt-label">镜头 PROMPT</span>
        {data.prompt}
      </div>
      <div className="pw-shot-refs">
        {data.refs.map((ref) => {
          const asset =
            ref.assetId !== undefined ? assets?.byId?.[ref.assetId] : undefined
          return (
            <span key={ref.id} className="pw-shot-ref">
              {asset !== undefined && asset.mime.startsWith('image/') && (
                <RefThumb key={asset.id} projectId={projectId} asset={asset} />
              )}
              {REF_ICONS[ref.kind]} {refText(ref)}
            </span>
          )
        })}
        <span className="pw-shot-ref pw-shot-ref-add" aria-hidden>
          ＋ 引用
        </span>
      </div>
      {settingsOpen && <NodeSettingsPanel node={{ id, type: 'shot', data }} />}
      <Handle type="target" position={Position.Top} className="pw-port" />
      <Handle type="source" position={Position.Right} className="pw-port" />
    </div>
  )
}
