import type { Edge } from '@xyflow/react'
import { describe, expect, it } from 'vitest'
import { branchOptionHandle } from './graphRules'
import { buildScriptExport, buildScriptMarkdown } from './exportScript'
import type { CanvasNode } from './nodes/types'
import { EMPTY_SETTINGS, type ProjectSettings } from './settings'

/** 画布节点夹具：数据字段按需给足，多出的 React Flow 必填项由 as 收口。 */
const mk = (n: unknown): CanvasNode => n as CanvasNode

const settings: ProjectSettings = {
  ...EMPTY_SETTINGS,
  characters: [{ id: 'ch1', name: '林晚', gradient: '' }],
  locations: [{ id: 'loc1', name: '天台' }],
}

/** 最小图：一场（带地点与角色）→ 一段对白（台词 + 动作），另挂一张分镜卡。 */
const nodes: CanvasNode[] = [
  mk({
    id: 's1',
    type: 'scene',
    position: { x: 0, y: 0 },
    data: {
      name: '天台夜话',
      sceneNo: 1,
      interior: false,
      time: '🌙 夜',
      weather: '小雨',
      synopsis: '摊牌。',
      characterIds: ['ch1'],
      locationId: 'loc1',
    },
    selected: false,
  }),
  mk({
    id: 'd1',
    type: 'dialogue',
    position: { x: 100, y: 0 },
    data: {
      name: '对白',
      lines: [
        { kind: 'action', text: '雨停了', speaker: null, vo: false },
        { kind: 'line', speaker: 'ch1', side: 'left', text: '我们到此为止。', vo: false },
        { kind: 'line', speaker: 'ch1', side: 'left', text: '（画外）别走。', vo: true },
      ],
    },
    selected: false,
  }),
  mk({
    id: 'shot1',
    type: 'shot',
    position: { x: 50, y: 200 },
    data: {
      shotNo: 1,
      size: '全景',
      picture: '雨夜天台',
      prompt: 'wide shot, rooftop',
      refs: [
        { id: 'r1', kind: 'location', label: '氛围图' },
        { id: 'r2', kind: 'audio', assetId: 'aud-1' },
        { id: 'r3', kind: 'character', assetId: 'gone-1' },
      ],
    },
    selected: false,
  }),
]

/** 项目资产索引：aud-1 存在，gone-1 已删（悬空引用按 §8.2.3 保留）。 */
const assets = {
  byId: {
    'aud-1': { id: 'aud-1', relPath: 'assets/aud-1.mp3', mime: 'audio/mpeg', source: 'upload', createdAt: '2026-01-01T00:00:00.000Z' },
  },
} as Parameters<typeof buildScriptMarkdown>[4]

const edges = [
  { id: 'e1', source: 's1', target: 'd1', sourceHandle: null },
  { id: 'attach1', source: 's1', target: 'shot1', sourceHandle: 'shots' },
] as unknown as Parameters<typeof buildScriptMarkdown>[2]

describe('buildScriptMarkdown（§3.5/§5 导出）', () => {
  const md = buildScriptMarkdown('样例剧', nodes, edges, settings, assets)

  it('场景头：场号 + 内外/地点/时间/天气 + 梗概 + 在场角色', () => {
    expect(md).toContain('## 场 01 · 天台夜话')
    expect(md).toContain('外 · 天台 · 🌙 夜 · 小雨')
    expect(md).toContain('> 摊牌。')
    expect(md).toContain('在场：林晚')
  })

  it('对白：动作括注、台词带说话人、VO 追注', () => {
    expect(md).toContain('（雨停了）')
    expect(md).toContain('林晚：我们到此为止。')
    expect(md).toContain('林晚：（画外）别走。（VO）')
  })

  it('分镜附录按宿主场分组，含 Prompt 与引用', () => {
    expect(md).toContain('## 附录 · 分镜卡')
    expect(md).toContain('### 场 01 · 天台夜话（1 镜）')
    expect(md).toContain('**SHOT 01 · 全景** — 雨夜天台')
    expect(md).toContain('Prompt：wide shot, rooftop')
    // 自由位出文案；引用位出资产 id（与卡片渲染同口径），悬空引用标注缺失
    expect(md).toContain('引用：氛围图 / aud-1 / gone-1（资产缺失）')
  })

  it('未提供资产索引时引用位按悬空标注（不静默丢引用资产）', () => {
    const bare = buildScriptMarkdown('x', nodes, edges, settings)
    expect(bare).toContain('引用：氛围图 / aud-1（资产缺失） / gone-1（资产缺失）')
  })

  it('节拍与分支不出现在正文；失效角色引用标注已删除', () => {
    expect(md).not.toContain('节拍')
    const broken = buildScriptMarkdown(
      'x',
      [mk({ ...nodes[0], data: { ...nodes[0].data, characterIds: ['ghost'] } })],
      [],
      settings,
    )
    expect(broken).toContain('在场：已删除角色')
  })
})

/** issue #48：带节奏卡与分支的混合项目（节奏 → 场景 → 分支 / 汇合）。 */
const mixNodes: CanvasNode[] = [
  mk({
    id: 'bt1',
    type: 'beat',
    position: { x: -100, y: 0 },
    data: { name: '立势', tone: '压抑', episodeNo: 1 },
  }),
  mk({
    id: 's1',
    type: 'scene',
    position: { x: 0, y: 0 },
    data: { name: '天台夜话', sceneNo: 1, interior: false, time: '🌙 夜', synopsis: '', characterIds: [], episodeNo: 1 },
  }),
  mk({
    id: 'd1',
    type: 'dialogue',
    position: { x: 100, y: 0 },
    data: { name: '摊牌', lines: [], episodeNo: 1 },
  }),
  mk({
    id: 'b1',
    type: 'branch',
    position: { x: 200, y: 0 },
    data: {
      prompt: '要不要坦白？',
      options: [
        { id: 'o1', label: '坦白' },
        { id: 'o2', label: '隐瞒' },
      ],
      episodeNo: 1,
    },
  }),
  mk({
    id: 's2',
    type: 'scene',
    position: { x: 300, y: 0 },
    data: { name: '旧公寓', sceneNo: 2, interior: true, time: '🌙 夜', synopsis: '', characterIds: [], episodeNo: 2 },
  }),
]

const mixEdges = [
  { id: 'm1', source: 'bt1', target: 's1', className: 'pw-edge-sequence' },
  { id: 'm2', source: 's1', target: 'd1', className: 'pw-edge-sequence' },
  { id: 'm3', source: 'd1', target: 'b1', className: 'pw-edge-sequence' },
  { id: 'm4', source: 'b1', sourceHandle: branchOptionHandle('o1'), target: 's2', type: 'branch' },
] as unknown as Edge[]

const mixEdgesTyped: Parameters<typeof buildScriptExport>[0]['edges'] = mixEdges

describe('buildScriptExport（issue #48 导出模型）', () => {
  const draft = buildScriptExport({
    projectName: '雨夜',
    nodes: mixNodes,
    edges: mixEdgesTyped,
    settings,
    assets: undefined,
    episodeTitles: { 1: '立势', 2: '汇合' },
  })

  it('默认关闭大纲：正文仍只由场景 + 对白生成，不含节奏与分支', () => {
    expect(draft.plain).toContain('## 场 01 · 天台夜话')
    expect(draft.plain).not.toContain('立势')
    expect(draft.plain).not.toContain('要不要坦白？')
    expect(draft.outline).not.toBe('')
    expect(draft.outline).toContain('要不要坦白？')
    expect(draft.hasNarrative).toBe(true)
  })

  it('开启大纲：并入同一生成结果的 Markdown，含集标题、基调、分支与去向', () => {
    const { outline } = draft
    expect(outline).toContain('## 附录 · 创作大纲')
    expect(outline).toContain('### 第 1 集 · 立势')
    expect(outline).toContain('### 第 2 集 · 汇合')
    expect(outline).toContain('节拍 · 立势 · 压抑')
    expect(outline).toContain('分支 · 要不要坦白？')
    expect(outline).toContain('坦白 → 场 02 · 旧公寓')
    expect(outline).toContain('隐瞒 → （未连线）')
    // 正文与分镜附录保持：正文在前，大纲附录在后
    expect(outline).toContain('对白 · 摊牌')
    expect(outline).toContain(draft.plain)
    expect(outline.indexOf('## 场 01')).toBeLessThan(outline.indexOf('## 附录 · 创作大纲'))
  })

  it('导出范围概要：集/场/对白/节拍/分支计数与大纲可用性', () => {
    expect(draft.summary).toEqual({
      episodes: [1, 2],
      scenes: 2,
      dialogues: 1,
      beats: 1,
      branches: 1,
      hasOutline: true,
    })
    expect(draft.scopeLine).toContain('2 集')
    expect(draft.scopeLine).toContain('2 场')
    expect(draft.scopeLine).toContain('1 节拍')
    expect(draft.scopeLine).toContain('1 分支')
  })

  it('只有节奏卡与分支、没有场景对白时：正文为空并给出提示，大纲仍可用', () => {
    const noBody = buildScriptExport({
      projectName: '空正文',
      nodes: [mixNodes[0], mixNodes[3]],
      edges: mixEdgesTyped,
      settings,
      assets: undefined,
      episodeTitles: {},
    })
    expect(noBody.hasNarrative).toBe(false)
    // 概要只列非零项：没有场景对白时不谎报计数
    expect(noBody.scopeLine).toBe('1 集 · 1 节拍 · 1 分支')
    // 大纲不依赖正文可用：正文仅剩文件头，附录仍输出节奏结构
    expect(noBody.outline).toContain('节拍 · 立势')
    expect(noBody.outline).toContain('分支 · 要不要坦白？')
  })
})
