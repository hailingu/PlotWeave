/** All number consumers retain a readable scene and its content when unnumbered (#933). */
import { expect, it } from 'vitest'
import { sceneNumberText } from './sceneNumber'
import { buildScriptMarkdown } from './exportScript'
import { buildExportOutline } from './exportOutline'
import { buildOutlineGroups, sceneLabel } from './outline'
import { sceneLabel as aiSceneLabel } from './ai/graphDigest'
import { buildCanvasNode } from './nodeFactory'
import type { SceneFlowNode, ShotFlowNode } from './nodes/types'

/** Scene without a number retains every other required domain field. */
const scene: SceneFlowNode = {
  id: 'scene',
  type: 'scene',
  position: { x: 0, y: 0 },
  data: {
    name: '天台',
    time: '夜',
    interior: false,
    synopsis: '雨后初晴',
    characterIds: [],
    episodeNo: 2,
  },
}
const shot: ShotFlowNode = {
  id: 'shot',
  type: 'shot',
  position: { x: 0, y: 200 },
  data: { shotNo: 1, size: '近景', picture: '雨滴', prompt: '', refs: [] },
}
const edges = [
  {
    id: 'attach',
    source: scene.id,
    target: shot.id,
    sourceHandle: 'shots',
    data: { kind: 'attach' as const },
  },
]
const settings = { characters: [], locations: [] }

it.each([
  [undefined, '未编号'],
  [1, '01'],
  [7, '07'],
  [123, '123'],
] as const)('formats %s without inventing a number', (value, expected) => {
  expect(sceneNumberText(value)).toBe(expected)
})

it('outline, beat labels and AI labels retain an unnumbered scene', () => {
  expect(sceneLabel(scene)).toBe('场 未编号 · 天台')
  expect(buildOutlineGroups([scene], [], {})[0].rows[0].label).toBe(
    '场 未编号 · 天台',
  )
  expect(aiSceneLabel(undefined, '天台')).toBe('场未编号·天台')
})

it('Markdown body and attached-shot appendix preserve unnumbered scene content', () => {
  const text = buildScriptMarkdown('项目', [scene, shot], edges, settings)
  expect(text).toContain('## 场 未编号 · 天台')
  expect(text).toContain('### 场 未编号 · 天台（1 镜）')
  expect(text).toContain('雨后初晴')
  expect(text).toContain('雨滴')
  expect(
    JSON.stringify(buildExportOutline([scene, shot], edges, {})),
  ).toContain('场 未编号 · 天台')
  expect(text).not.toMatch(/undefined|NaN|场 00/)
})

it('new scene allocation ignores unnumbered scenes and preserves existing nodes', () => {
  const existing = {
    ...scene,
    id: 'numbered',
    data: { ...scene.data, sceneNo: 7 },
  }
  const node = buildCanvasNode('scene', undefined, {
    against: [scene, existing],
    characters: [],
    center: null,
  })
  expect(node.data.sceneNo).toBe(8)
  expect(scene.data.sceneNo).toBeUndefined()
  expect(existing.data.sceneNo).toBe(7)
})
