import type { Edge } from '@xyflow/react'
import { SCENE_SHOT_HANDLE } from './nodes/SceneNode'
import { resolveCharacterName, resolveLocationName, type ProjectSettings } from './settings'
import type { ProjectContent } from '../model/content'
import type { CanvasNode, DialogueFlowNode, DialogueLine, SceneFlowNode, ShotFlowNode, ShotRef } from './nodes/types'

/**
 * 剧本导出生成器（docs/ui-design.md §3.5/§5）。
 * 正文只由场景 + 对白生成，节拍与分支不出现；
 * 分镜卡以附录按宿主场分组输出（含镜头 Prompt 与引用位）。
 * 场景顺序 = 画布横向剧情流（position.x 排序）。
 */

/** 说话人 id → 设定集全名（失效引用标注，§4.3）。 */
function speakerName(settings: ProjectSettings, id: string): string {
  return resolveCharacterName(settings, id) ?? '已删除角色'
}

/** 场景地点名：地点已删除时标注占位（S3358：嵌套三元独立成函数）。 */
function locationLabel(settings: ProjectSettings, locationId: string | undefined): string | null {
  if (!locationId) return null
  return resolveLocationName(settings, locationId) ?? '（地点已删除）'
}

/** 引用位显示名（§8.1，与卡片渲染同口径）：自由位出手填文案；引用位出
 * 资产 id 供生产端按稳定标识取材（资产实体暂无名称字段），悬空引用（资产
 * 已删，§8.2.3 保留引用本身）标注缺失——导出不得静默丢掉引用资产。
 * 存在性按 own 属性判定：普通对象括号取值会被 'constructor' 等原型链键
 * 误判为存在（库内键控桶同款防原型链误命中口径）。 */
function refText(assets: ProjectContent['assets'], ref: ShotRef): string {
  if (ref.label !== undefined) return ref.label
  const byId = assets?.byId
  const exists =
    byId !== undefined && Object.prototype.hasOwnProperty.call(byId, ref.assetId)
  return exists ? ref.assetId : `${ref.assetId}（资产缺失）`
}

/** 单场分镜附录：按 attach 边归组、镜号排序。 */
function shotAppendixLines(
  scene: SceneFlowNode,
  nodes: CanvasNode[],
  edges: Edge[],
  assets: ProjectContent['assets'],
): string[] {
  const shots = edges
    .filter((e) => e.source === scene.id && e.sourceHandle === SCENE_SHOT_HANDLE)
    .map((e) => nodes.find((n) => n.id === e.target))
    .filter((n): n is ShotFlowNode => n?.type === 'shot')
    .sort((a, b) => a.data.shotNo - b.data.shotNo)
  if (shots.length === 0) return []
  const lines: string[] = []
  lines.push(
    `### 场 ${String(scene.data.sceneNo).padStart(2, '0')} · ${scene.data.name}（${shots.length} 镜）`,
    '',
  )
  for (const shot of shots) {
    lines.push(`- **SHOT ${String(shot.data.shotNo).padStart(2, '0')} · ${shot.data.size}** — ${shot.data.picture}`)
    if (shot.data.prompt) lines.push(`  - Prompt：${shot.data.prompt}`)
    if (shot.data.refs.length > 0) {
      lines.push(`  - 引用：${shot.data.refs.map((r) => refText(assets, r)).join(' / ')}`)
    }
  }
  lines.push('')
  return lines
}

/** 场景标题块：场号/名 + 内外·地点·时间·天气 + 梗概 + 在场角色。 */
function sceneBlockLines(node: SceneFlowNode, settings: ProjectSettings): string[] {
  const d = node.data
  const meta = [d.interior ? '内' : '外', locationLabel(settings, d.locationId), d.time, d.weather]
    .filter(Boolean)
    .join(' · ')
  const lines = [`## 场 ${String(d.sceneNo).padStart(2, '0')} · ${d.name}`, '', meta, '']
  if (d.synopsis) lines.push(`> ${d.synopsis}`, '')
  const cast = d.characterIds.map((id) => speakerName(settings, id)).join('、')
  if (cast) lines.push(`在场：${cast}`, '')
  return lines
}

/** 对白块的一行台词：说话人缺失标注「？」，VO 追注。 */
function dialogueLineText(settings: ProjectSettings, line: DialogueLine): string {
  const name = line.speaker ? speakerName(settings, line.speaker) : '？'
  const vo = line.vo ? '（VO）' : ''
  return `${name}：${line.text}${vo}`
}

/** 对白块：动作行（括注）与台词行交替。 */
function dialogueBlockLines(node: DialogueFlowNode, settings: ProjectSettings): string[] {
  const lines: string[] = []
  for (const line of node.data.lines) {
    if (line.kind === 'action') lines.push(`（${line.text}）`)
    else lines.push(dialogueLineText(settings, line))
  }
  lines.push('')
  return lines
}

/** 生成整部剧本的 Markdown 文本。assets 为项目资产索引（缺省视为无资产，
 * 引用位全部按悬空标注）。 */
export function buildScriptMarkdown(
  projectName: string,
  nodes: CanvasNode[],
  edges: Edge[],
  settings: ProjectSettings,
  assets?: ProjectContent['assets'],
): string {
  const ordered = [...nodes].sort((a, b) => a.position.x - b.position.x)
  const lines: string[] = [`# ${projectName}`, '']
  lines.push(`> 由 PlotWeave 导出 · ${new Date().toLocaleDateString('zh-CN')}`, '')

  for (const node of ordered) {
    if (node.type === 'scene') lines.push(...sceneBlockLines(node, settings))
    else if (node.type === 'dialogue') lines.push(...dialogueBlockLines(node, settings))
  }

  const appendix = ordered
    .filter((n): n is SceneFlowNode => n.type === 'scene')
    .flatMap((scene) => shotAppendixLines(scene, nodes, edges, assets))
  if (appendix.length > 0) {
    lines.push('---', '', '## 附录 · 分镜卡', '', ...appendix)
  }

  return lines.join('\n')
}
