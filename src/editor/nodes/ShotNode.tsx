import { useEffect, useState } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { useNodeEdit } from '../nodeEdit'
import { projectAssets } from '../projectAssets'
import NodeSettingsPanel from './settings/NodeSettingsPanel'
import type { AssetRef } from '../../model/document'
import type { ShotFlowNode } from './types'

/** 引用位 chip 的图标：角色垫图 / 场景底图 / 音频。 */
const REF_ICONS = { character: '👤', location: '🏞', audio: '🎵' } as const

/** 引用位缩略图（§8.1）：image/* 资产经项目资产门面解析媒体 URL 懒渲染；
 * 解析失败/非图片不渲染图，chip 回退纯文本。 */
function RefThumb({ projectId, asset }: { readonly projectId: string; readonly asset: AssetRef }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    projectAssets
      .mediaUrl(projectId, asset)
      .then((u) => {
        if (alive) setUrl(u)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [projectId, asset])
  if (!url) return null
  return <img className="pw-shot-ref-thumb" src={url} alt={asset.relPath} />
}

/**
 * 分镜卡 = 监视器卡（docs/ui-design.md §4.2，生成侧深色石板，双外观恒定）。
 * 一张卡 = 一个镜头及其 AI 燃料：镜号 + 景别标题行（常驻 ⚙️）、
 * 画面描述、镜头 Prompt、垫图/底图/音频引用位。
 * 从属关系走顶部入口：宿主索引卡底部端口垂直下挂（§4.4 attach 边）。
 * ⚙️ 打开设置面板（§4.3，编辑即命令）；镜号标题行不设内联改名。
 */
export default function ShotNode({ id, data, selected }: NodeProps<ShotFlowNode>) {
  const { projectId, openSettingsId, toggleSettings, assets } = useNodeEdit()
  const settingsOpen = openSettingsId === id

  /** 引用位显示名（§8.1）：自由位显示手填文案；引用位回退 assetId 供辨认
   *（image/* 资产另渲染缩略图）。 */
  const refText = (ref: ShotFlowNode['data']['refs'][number]): string =>
    ref.label ?? ref.assetId ?? ''

  return (
    <div className={`pw-shot${selected ? ' pw-on' : ''}`}>
      <div className="pw-shot-tb">
        <span className="pw-shot-no">SHOT {String(data.shotNo).padStart(2, '0')}</span>
        <span className="pw-shot-size">{data.size}</span>
        <span className="pw-sp" />
        <button
          type="button"
          className={`pw-gear nodrag${settingsOpen ? ' pw-gear-open' : ''}`}
          data-pw-gear
          aria-label="分镜设置"
          aria-expanded={settingsOpen}
          onClick={(e) => {
            e.stopPropagation()
            toggleSettings(id)
          }}
        >
          ⚙️
        </button>
      </div>
      <p className="pw-shot-picture">{data.picture}</p>
      <div className="pw-shot-prompt">
        <span className="pw-shot-prompt-label">镜头 PROMPT</span>
        {data.prompt}
      </div>
      <div className="pw-shot-refs">
        {data.refs.map((ref) => {
          const asset = ref.assetId !== undefined ? assets?.byId?.[ref.assetId] : undefined
          return (
            <span key={ref.id} className="pw-shot-ref">
              {asset !== undefined && asset.mime.startsWith('image/') && (
                <RefThumb projectId={projectId} asset={asset} />
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
