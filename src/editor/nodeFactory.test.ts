import { describe, expect, it } from 'vitest'
import { buildCanvasNode, type NodeFactoryCtx } from './nodeFactory'
import type { CanvasNode, SceneFlowNode, ShotFlowNode } from './nodes/types'

function sceneNode(id: string, sceneNo: number): SceneFlowNode {
  return {
    id,
    type: 'scene',
    position: { x: 0, y: 0 },
    data: {
      name: `场${sceneNo}`,
      sceneNo,
      interior: true,
      time: '🌙 夜',
      synopsis: '…',
      characterIds: [],
    },
  }
}

function shotNodeOf(id: string, shotNo: number): ShotFlowNode {
  return {
    id,
    type: 'shot',
    position: { x: 0, y: 0 },
    data: { shotNo, size: '中景', picture: '…', prompt: '', refs: [] },
  }
}

const ctx = (over: Partial<NodeFactoryCtx> = {}): NodeFactoryCtx => ({
  against: [],
  characters: [{ id: 'c1' }],
  center: null,
  ...over,
})

describe('buildCanvasNode（节点工厂：默认字段 + 落点）', () => {
  it('场景：场号取基线最大值 +1；空基线从 1 起', () => {
    const n1 = buildCanvasNode('scene', undefined, ctx())
    expect(n1.type).toBe('scene')
    expect(n1.data).toMatchObject({ name: '新场景', sceneNo: 1, interior: true, characterIds: [] })

    const against: CanvasNode[] = [sceneNode('s1', 2), sceneNode('s2', 5)]
    const n2 = buildCanvasNode('scene', undefined, ctx({ against }))
    expect(n2.data.sceneNo).toBe(6)
  })

  it('对白：首行说话人取设定集首位角色（带稳定 id）；无角色时 speaker 为 undefined', () => {
    const withChar = buildCanvasNode('dialogue', undefined, ctx())
    const lines = withChar.data.lines as Array<{ id: string; kind: string; speaker?: string }>
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ kind: 'line', speaker: 'c1', side: 'left', text: '新台词…' })
    expect(lines[0].id).toMatch(/^line-/)
    const noChar = buildCanvasNode('dialogue', undefined, ctx({ characters: [] }))
    const bareLines = noChar.data.lines as Array<{ speaker?: string }>
    expect(bareLines[0]).toMatchObject({ kind: 'line', speaker: undefined, side: 'left', text: '新台词…' })
  })

  it('节奏卡 / 分支 / 分镜卡默认字段；分镜镜号独立编号', () => {
    const beat = buildCanvasNode('beat', undefined, ctx())
    expect(beat.data).toMatchObject({ name: '新节拍', tone: '待定' })
    const branch = buildCanvasNode('branch', undefined, ctx())
    const bd = branch.data as { prompt: string; options: Array<{ id: string; label: string }> }
    expect(bd.prompt).toBe('新的分岔是…？')
    expect(bd.options.map((o) => o.label)).toEqual(['选项 A', '选项 B'])
    expect(bd.options.every((o) => o.id.startsWith('opt-'))).toBe(true)

    const shot = buildCanvasNode('shot', undefined, ctx({ against: [shotNodeOf('sh1', 3)] }))
    expect(shot.data).toMatchObject({ shotNo: 4, size: '中景', refs: [] })
  })

  it('opts.data 覆盖默认字段；selected 默认 true', () => {
    const n = buildCanvasNode('scene', { data: { name: '定制' } }, ctx())
    expect(n.data.name).toBe('定制')
    expect(n.selected).toBe(true)
    const unsel = buildCanvasNode('beat', { selected: false }, ctx())
    expect(unsel.selected).toBe(false)
  })

  it('落点：opts.at 优先；否则视口中心 + 节点数阶梯偏移；无中心则原点', () => {
    const at = buildCanvasNode('beat', { at: { x: 7, y: 9 } }, ctx())
    expect(at.position).toEqual({ x: 7, y: 9 })

    const c = buildCanvasNode('beat', undefined, ctx({ center: { x: 500, y: 300 } }))
    expect(c.position).toEqual({ x: 330, y: 240 })

    // 基线 3 个节点 → cascade = (3 % 5) * 28 = 84
    const against: CanvasNode[] = [sceneNode('a', 1), sceneNode('b', 2), sceneNode('c', 3)]
    const cascaded = buildCanvasNode('beat', undefined, ctx({ against, center: { x: 500, y: 300 } }))
    expect(cascaded.position).toEqual({ x: 330 + 84, y: 240 + 84 })

    const origin = buildCanvasNode('beat', undefined, ctx())
    expect(origin.position).toEqual({ x: 0, y: 0 })
  })

  it('批量基线：ctx.against 传模拟数组时编号跟随虚拟终态（防重号）', () => {
    const simNodes: CanvasNode[] = [sceneNode('s1', 1)]
    const first = buildCanvasNode('scene', undefined, ctx({ against: simNodes }))
    expect(first.data.sceneNo).toBe(2)
    const second = buildCanvasNode('scene', undefined, ctx({ against: [...simNodes, first] }))
    expect(second.data.sceneNo).toBe(3)
  })
})
