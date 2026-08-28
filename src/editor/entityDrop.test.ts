import { describe, expect, it } from 'vitest'
import { entityDropPatch } from './entityDrop'
import type { EntityDragPayload } from './dragDrop'
import type { CanvasNode } from './nodes/types'
import type {
  BeatFlowNode,
  BranchFlowNode,
  DialogueFlowNode,
  SceneFlowNode,
  ShotFlowNode,
  ShotRef,
} from './nodes/types'

const char: EntityDragPayload = { kind: 'character', id: 'c1', name: '阿黎' }
const loc: EntityDragPayload = { kind: 'location', id: 'l1', name: '咖啡馆' }

function sceneNode(characterIds: string[] = []): SceneFlowNode {
  return {
    id: 's1',
    type: 'scene',
    position: { x: 0, y: 0 },
    data: {
      name: '新场景',
      sceneNo: 1,
      interior: true,
      time: '🌙 夜',
      synopsis: '…',
      characterIds,
    },
  }
}

function dialogueNode(): DialogueFlowNode {
  return {
    id: 'd1',
    type: 'dialogue',
    position: { x: 0, y: 0 },
    data: {
      name: '对白',
      lines: [{ id: 'line-0', kind: 'line', speaker: 'c0', side: 'left', text: '你好' }],
    },
  }
}

function shotNode(refs: ShotRef[] = []): ShotFlowNode {
  return {
    id: 'sh1',
    type: 'shot',
    position: { x: 0, y: 0 },
    data: { shotNo: 1, size: '中景', picture: '…', prompt: '', refs },
  }
}

describe('entityDropPatch（§5 设定集实体拖上节点 = 建立引用）', () => {
  it('角色 → 索引卡：追加出场角色 id；已在场则去重返回 null', () => {
    expect(entityDropPatch(sceneNode(), char)).toEqual({ characterIds: ['c1'] })
    expect(entityDropPatch(sceneNode(['c1']), char)).toBeNull()
  })

  it('角色 → 对白：追加一条以该角色为说话人的新台词（带稳定 id），原有行保留', () => {
    const patch = entityDropPatch(dialogueNode(), char) as { lines: { id: string }[] }
    expect(patch.lines).toHaveLength(2)
    expect(patch.lines[1]).toMatchObject({ kind: 'line', speaker: 'c1', side: 'left', text: '新台词…' })
    expect(patch.lines[1].id).toMatch(/^line-/)
  })

  it('角色 → 分镜卡：追加垫图引用（targetId = 实体 id，§8.1）；同目标去重返回 null', () => {
    const patch = entityDropPatch(shotNode(), char) as { refs: ShotRef[] }
    expect(patch.refs).toHaveLength(1)
    expect(patch.refs[0]).toMatchObject({ kind: 'character', targetId: 'c1' })
    expect(patch.refs[0].id).toMatch(/^ref-/)
    const dup = shotNode([{ id: 'r0', kind: 'character', targetId: 'c1' }])
    expect(entityDropPatch(dup, char)).toBeNull()
  })

  it('角色 → 节奏卡 / 分支：不接收，返回 null', () => {
    const beat: BeatFlowNode = {
      id: 'b1',
      type: 'beat',
      position: { x: 0, y: 0 },
      data: { name: '节拍', tone: '待定' },
    }
    const branch: BranchFlowNode = {
      id: 'br1',
      type: 'branch',
      position: { x: 0, y: 0 },
      data: { prompt: '？', options: [{ id: 'oa', label: 'A' }, { id: 'ob', label: 'B' }] },
    }
    expect(entityDropPatch(beat as CanvasNode, char)).toBeNull()
    expect(entityDropPatch(branch as CanvasNode, char)).toBeNull()
  })

  it('地点 → 索引卡：写入 locationId；→ 分镜卡：追加底图引用（targetId）并去重', () => {
    expect(entityDropPatch(sceneNode(), loc)).toEqual({ locationId: 'l1' })
    const patch = entityDropPatch(shotNode(), loc) as { refs: ShotRef[] }
    expect(patch.refs).toHaveLength(1)
    expect(patch.refs[0]).toMatchObject({ kind: 'location', targetId: 'l1' })
    const dup = shotNode([{ id: 'r0', kind: 'location', targetId: 'l1' }])
    expect(entityDropPatch(dup, loc)).toBeNull()
  })

  it('地点 → 对白 / 节奏卡：不接收，返回 null', () => {
    expect(entityDropPatch(dialogueNode(), loc)).toBeNull()
  })
})
