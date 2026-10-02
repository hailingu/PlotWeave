/**
 * 首次启动的种子项目（issue #39 自 projectStore.ts 拆出）：沿用演示画布，
 * 让首页与编辑器开箱即有内容。内存回退播种与 Tauri 空库播种共用。
 */
import { SAMPLE_NODES, SAMPLE_EDGES } from '../editor/sampleGraph'
import { SAMPLE_SETTINGS } from '../editor/sampleData'
import type { ProjectContent } from '../model/content'
import type { ProjectSummary } from '../home/projects'

/** 种子示例项目清单（语义见模块头：首启/空库播种与内存回退共用）：
 * 返回 meta + doc 对，供播种路径按 no-replace 语义写入。 */
export function seedProjects(): {
  meta: ProjectSummary
  doc: ProjectContent
}[] {
  const hoursAgo = (h: number) =>
    new Date(Date.now() - h * 3_600_000).toISOString()
  const sceneCount = SAMPLE_NODES.filter((n) => n.type === 'scene').length
  return [
    {
      meta: {
        id: 'sample-wu-ye-chu-zu-che',
        name: '午夜出租车',
        sceneCount,
        endingCount: 2,
        updatedAt: hoursAgo(26),
      },
      doc: {
        name: '午夜出租车',
        nodes: SAMPLE_NODES,
        edges: SAMPLE_EDGES,
        settings: SAMPLE_SETTINGS,
      },
    },
    {
      meta: {
        id: 'sample-du-shi-qi-yuan',
        name: '都市奇缘',
        sceneCount: 24,
        endingCount: 2,
        cover: 'linear-gradient(160deg, #2b2f4c, #e0176e)',
        updatedAt: hoursAgo(2),
      },
      doc: {
        name: '都市奇缘',
        nodes: SAMPLE_NODES,
        edges: SAMPLE_EDGES,
        settings: SAMPLE_SETTINGS,
      },
    },
  ]
}
