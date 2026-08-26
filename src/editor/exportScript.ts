import type { Edge } from '@xyflow/react'
import { SCENE_SHOT_HANDLE } from './nodes/SceneNode'
import { resolveCharacterName, resolveLocationName, type ProjectSettings } from './settings'
import type { CanvasNode, SceneFlowNode, ShotFlowNode } from './nodes/types'

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

/** 单场分镜附录：按 attach 边归组、镜号排序。 */
function shotAppendixLines(scene: SceneFlowNode, nodes: CanvasNode[], edges: Edge[]): string[] {
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
      lines.push(`  - 引用：${shot.data.refs.map((r) => r.label).join(' / ')}`)
    }
  }
  lines.push('')
  return lines
}

/** 生成整部剧本的 Markdown 文本。 */
export function buildScriptMarkdown(
  projectName: string,
  nodes: CanvasNode[],
  edges: Edge[],
  settings: ProjectSettings,
): string {
  const ordered = [...nodes].sort((a, b) => a.position.x - b.position.x)
  const lines: string[] = [`# ${projectName}`, '']
  lines.push(`> 由 PlotWeave 导出 · ${new Date().toLocaleDateString('zh-CN')}`, '')

  for (const node of ordered) {
    if (node.type === 'scene') {
      const d = node.data
      const locationName = d.locationId ? resolveLocationName(settings, d.locationId) : null
      const meta = [
        d.interior ? '内' : '外',
        locationName ?? (d.locationId ? '（地点已删除）' : null),
        d.time,
        d.weather,
      ]
        .filter(Boolean)
        .join(' · ')
      lines.push(`## 场 ${String(d.sceneNo).padStart(2, '0')} · ${d.name}`, '', meta, '')
      if (d.synopsis) lines.push(`> ${d.synopsis}`, '')
      const cast = d.characterIds.map((id) => speakerName(settings, id)).join('、')
      if (cast) lines.push(`在场：${cast}`, '')
    } else if (node.type === 'dialogue') {
      for (const line of node.data.lines) {
        if (line.kind === 'action') {
          lines.push(`（${line.text}）`)
        } else {
          const name = line.speaker ? speakerName(settings, line.speaker) : '？'
          lines.push(`${name}：${line.text}${line.vo ? '（VO）' : ''}`)
        }
      }
      lines.push('')
    }
  }

  const appendix = ordered
    .filter((n): n is SceneFlowNode => n.type === 'scene')
    .flatMap((scene) => shotAppendixLines(scene, nodes, edges))
  if (appendix.length > 0) {
    lines.push('---', '', '## 附录 · 分镜卡', '', ...appendix)
  }

  return lines.join('\n')
}
