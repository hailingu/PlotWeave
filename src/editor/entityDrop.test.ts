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
    expect(entityDropPatch(sceneNode(), char)).toEqual({
      nodeType: 'scene',
      patch: { characterIds: ['c1'] },
    })
    expect(entityDropPatch(sceneNode(['c1']), char)).toBeNull()
  })

  it('角色 → 对白：追加一条以该角色为说话人的新台词（带稳定 id），原有行保留', () => {
    const cmd = entityDropPatch(dialogueNode(), char)
    const lines = cmd?.nodeType === 'dialogue' ? (cmd.patch.lines ?? []) : []
    expect(lines).toHaveLength(2)
    expect(lines[1]).toMatchObject({ kind: 'line', speaker: 'c1', side: 'left', text: '新台词…' })
    expect(lines[1].id).toMatch(/^line-/)
  })

  it('角色 → 分镜卡：无资产时落自由位引用（label = 实体名，§4.2）；同名去重返回 null', () => {
    const cmd = entityDropPatch(shotNode(), char)
    const refs = cmd?.nodeType === 'shot' ? (cmd.patch.refs ?? []) : []
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({ kind: 'character', label: '阿黎' })
    expect(refs[0].id).toMatch(/^ref-/)
    const dup = shotNode([{ id: 'r0', kind: 'character', label: '阿黎' }])
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

  it('地点 → 索引卡：写入 locationId；→ 分镜卡：落自由位引用（label = 实体名）并去重', () => {
    expect(entityDropPatch(sceneNode(), loc)).toEqual({ nodeType: 'scene', patch: { locationId: 'l1' } })
    const cmd = entityDropPatch(shotNode(), loc)
    const refs = cmd?.nodeType === 'shot' ? (cmd.patch.refs ?? []) : []
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({ kind: 'location', label: '咖啡馆' })
    const dup = shotNode([{ id: 'r0', kind: 'location', label: '咖啡馆' }])
    expect(entityDropPatch(dup, loc)).toBeNull()
  })

  it('地点 → 对白 / 节奏卡：不接收，返回 null', () => {
    expect(entityDropPatch(dialogueNode(), loc)).toBeNull()
  })
})
