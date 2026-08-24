import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { SceneFlowNode } from './types'

/**
 * 场景节点 = 场记板（docs/ui-design.md §4.2，片场族）。
 * 顶部黑白斜纹拍板条 + 深色石板板面（双外观恒定的内容层视觉）；
 * 板面分区对应真实场记板字段：标题栏（名称 + SCENE 编号 + 🎞 镜数 + ⚙️）、
 * 地点/时间行、梗概、在场角色头像串。
 * 选中反馈：拍板条弹簧张开 ~9°，品牌渐变描边只包板面。
 * 结构先行：⚙️ 设置面板、双击改名等交互随后续任务落地。
 */
export default function SceneNode({ data, selected }: NodeProps<SceneFlowNode>) {
  return (
    <div className={`pw-slate${selected ? ' pw-on' : ''}`}>
      <div className="pw-slate-wrap">
        <div className="pw-slate-clap" aria-hidden />
        <div className="pw-slate-board">
          <div className="pw-slate-tb">
            <span className="pw-slate-name">{data.name}</span>
            <span className="pw-slate-no">
              SCENE {String(data.sceneNo).padStart(2, '0')}
            </span>
            <span className="pw-sp" />
            <span className="pw-slate-shots">🎞 {data.shotCount} 镜</span>
            <button type="button" className="pw-gear" aria-label="场景设置">
              ⚙️
            </button>
          </div>
          <div className="pw-slate-meta">
            <span className="pw-slate-ie">{data.interior ? '内' : '外'}</span>
            <span>📍 {data.location}</span>
            <span className="pw-slate-sep">|</span>
            <span>{data.time}</span>
            {data.weather && <span className="pw-slate-wx">{data.weather}</span>}
          </div>
          <div className="pw-slate-div" />
          <p className="pw-slate-syn">{data.synopsis}</p>
          {data.characters.length > 0 && (
            <div className="pw-avs">
              {data.characters.map((c) => (
                <span
                  key={c.label}
                  className="pw-av"
                  style={{ background: c.gradient }}
                >
                  {c.label}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      <Handle type="target" position={Position.Left} className="pw-port" />
      <Handle type="source" position={Position.Right} className="pw-port" />
    </div>
  )
}
