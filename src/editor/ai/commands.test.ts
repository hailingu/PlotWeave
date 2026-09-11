import { describe, expect, it } from 'vitest'
import { validateAiBatch, type AiGraphSnapshot } from './commands'
import { wouldCreateCycle } from '../graphRules'
import { richSnap, snap } from './testGraphs'

describe('validateAiBatch：校验折叠（数据模型 §12，执行前批量预览）', () => {
  it('合法混合批次逐项折叠；commands 保持原始执行顺序', () => {
    const v = validateAiBatch(
      [
        { op: 'update_node', nodeId: 'n1', patch: { synopsis: '雨中分手' }, reason: '加强冲突' },
        { op: 'delete_node', nodeId: 'n2', reason: '并入场景' },
        { op: 'create_node', nodeType: 'scene', ref: 'a', data: { name: '雨夜追逐' } },
        { op: 'connect_edge', sourceId: 'a', targetId: 'n1' },
      ],
      snap(),
    )
    expect(v.ok).toBe(true)
    expect(v.hasDeletes).toBe(true)
    expect(v.commands.map((c) => c.op)).toEqual([
      'update_node',
      'delete_node',
      'create_node',
      'connect_edge',
    ])
  })

  it('删除类条目置顶且标记 danger，其余保持顺序', () => {
    const v = validateAiBatch(
      [
        { op: 'update_node', nodeId: 'n1', patch: { time: '🌅 晨' } },
        { op: 'delete_node', nodeId: 'n2' },
        { op: 'create_node', nodeType: 'beat', data: { name: '转折' } },
      ],
      snap(),
    )
    expect(v.items[0]).toMatchObject({ kind: 'delete', danger: true })
    expect(v.items.slice(1).every((i) => i.kind !== 'delete')).toBe(true)
  })

  it('任一条非法则整批拒绝（原子性）并给出可读问题', () => {
    for (const bad of [
      { op: 'delete_node', nodeId: 'ghost' },
      { op: 'update_node', nodeId: 'n1', patch: {} },
      { op: 'update_node', nodeId: 'ghost', patch: { name: 'x' } },
      { op: 'create_node', nodeType: 'dragon' },
      { op: 'bogus_op' },
      { op: 'connect_edge', sourceId: 'n1', targetId: 'n1' },
      { op: 'connect_edge', sourceId: 'n1', targetId: 'n2' }, // 成环
      { op: 'connect_edge', sourceId: 'n2', targetId: 'n1' }, // 重复
      { op: 'disconnect_edge', sourceId: 'n1', targetId: 'n2' }, // 无此边
    ]) {
      const v = validateAiBatch([bad], snap())
      expect(v.ok, JSON.stringify(bad)).toBe(false)
      expect(v.issues.length).toBeGreaterThanOrEqual(1)
    }
  })

  it('批次内引用：ref 建立的新节点可被后续命令使用，先删后连被拒', () => {
    const okV = validateAiBatch(
      [
        { op: 'create_node', nodeType: 'branch', ref: 'x', data: { prompt: '追或不追？' } },
        { op: 'connect_edge', sourceId: 'n1', targetId: 'x' },
      ],
      snap(),
    )
    expect(okV.ok).toBe(true)

    const badV = validateAiBatch(
      [
        { op: 'create_node', nodeType: 'shot', ref: 's' },
        { op: 'delete_node', nodeId: 's' },
        { op: 'connect_edge', sourceId: 'n1', targetId: 's' },
      ],
      snap(),
    )
    expect(badV.ok).toBe(false)
  })
})

/** 测试用快照：场景 s1 + 对白 d1；设定集含角色 ch-1（陈默）与地点 loc-1（茶馆）。 */
function entSnap(): AiGraphSnapshot {
  return {
    nodes: [
      { id: 's1', type: 'scene', label: '场 01 · 茶馆' },
      { id: 'd1', type: 'dialogue', label: '对白 · 对质' },
    ],
    edges: [],
    assets: new Map(),
    settings: {
      characters: [{ id: 'ch-1', name: '陈默' }],
      locations: [{ id: 'loc-1', name: '茶馆' }],
    },
  }
}

describe('validateAiBatch · 实体折叠与预览产出（新建 / 修改 / 同批绑定 ref，issue 44）', () => {
  it('同批「新建角色/地点 → 场景与对白绑定 ref」逐项折叠；实体改动进预览', () => {
    const v = validateAiBatch(
      [
        { op: 'upsert_character', ref: 'hero', fields: { name: '林一', bio: '落魄侦探' }, reason: '主角' },
        { op: 'upsert_location', ref: 'home', fields: { name: '公寓' } },
        {
          op: 'create_node',
          nodeType: 'scene',
          ref: 'sc',
          data: { name: '开场', characterIds: ['hero'], locationId: 'home' },
        },
        { op: 'update_node', nodeId: 's1', patch: { characterIds: ['ch-1', 'hero'] } },
        {
          op: 'update_node',
          nodeId: 'd1',
          patch: { lines: [{ kind: 'line', speaker: 'hero', text: '你来了。' }] },
        },
      ],
      entSnap(),
    )
    expect(v.ok).toBe(true)
    expect(v.issues).toEqual([])
    expect(v.commands.map((c) => c.op)).toEqual([
      'upsert_character',
      'upsert_location',
      'create_node',
      'update_node',
      'update_node',
    ])
    const itemKinds = v.items.map((i) => i.kind)
    expect(itemKinds).toContain('create_entity')
    expect(itemKinds).toContain('update')
    expect(v.items.find((i) => i.kind === 'create_entity')?.label).toContain('林一')
  })

  it('已有实体补充 bio：entityId 精确指向，预览标 update_entity 且只列变更字段', () => {
    const v = validateAiBatch(
      [{ op: 'upsert_character', entityId: 'ch-1', fields: { bio: '戒了三年又复吸' } }],
      entSnap(),
    )
    expect(v.ok).toBe(true)
    expect(v.items[0]).toMatchObject({ kind: 'update_entity' })
    expect(v.items[0].label).toContain('陈默')
    expect(v.items[0].label).toContain('bio')
    expect(v.commands[0]).toMatchObject({ op: 'upsert_character', entityId: 'ch-1' })
  })

  it('修改未提及 name：执行命令 fields 只含写入键（归一化不注入空名，预览→执行同口径）', () => {
    const v = validateAiBatch(
      [{ op: 'upsert_character', entityId: 'ch-1', fields: { bio: '新小传' } }],
      entSnap(),
    )
    expect(v.ok).toBe(true)
    expect((v.commands[0] as { fields: Record<string, unknown> }).fields).toEqual({
      bio: '新小传',
    })
    // 预览标签只列实际写入的字段，不把未提及的 name 列为变更
    expect(v.items[0].label).toContain('（bio）')
  })
})

describe('validateAiBatch · 实体 fields 校验（白名单 / 值形状 / name 约束，issue 44）', () => {
  it('创建缺 name、未知字段、非字符串值、update 空 fields 均整批拒绝', () => {
    for (const bad of [
      { op: 'upsert_character', fields: { bio: '没有名字' } },
      { op: 'upsert_character', fields: {} },
      { op: 'upsert_location', fields: { name: '公寓', zone: '城西' } },
      { op: 'upsert_character', fields: { name: 42 } },
      { op: 'upsert_character', fields: '林一' },
      { op: 'upsert_character', entityId: 'ch-1', fields: {} },
    ]) {
      const v = validateAiBatch([bad], entSnap())
      expect(v.ok, JSON.stringify(bad)).toBe(false)
      expect(v.issues.length).toBeGreaterThanOrEqual(1)
      expect(v.commands).toEqual([])
    }
  })

  it('update 的 name 不能为空白；创建 name 去空白后进命令', () => {
    const blank = validateAiBatch(
      [{ op: 'upsert_character', entityId: 'ch-1', fields: { name: '   ' } }],
      entSnap(),
    )
    expect(blank.ok).toBe(false)

    const v = validateAiBatch(
      [{ op: 'upsert_character', fields: { name: '  林一  ' } }],
      entSnap(),
    )
    expect(v.ok).toBe(true)
    expect(v.commands[0]).toMatchObject({ fields: { name: '林一' } })
  })
})

describe('validateAiBatch · entityId 解析与结构化引用校验（issue 44）', () => {
  it('entityId 指向不存在实体或跨种类实体均拒绝', () => {
    const ghost = validateAiBatch(
      [{ op: 'upsert_character', entityId: 'ch-404', fields: { bio: 'x' } }],
      entSnap(),
    )
    expect(ghost.ok).toBe(false)
    expect(ghost.issues[0].message).toContain('不存在')

    const cross = validateAiBatch(
      [{ op: 'upsert_character', entityId: 'loc-1', fields: { bio: 'x' } }],
      entSnap(),
    )
    expect(cross.ok).toBe(false)
    expect(cross.issues[0].message).toContain('地点')
  })

  it('场景/对白引用：跨类型误绑与未知实体整批拒绝（引用类型校验）', () => {
    const crossType = validateAiBatch(
      [{ op: 'update_node', nodeId: 's1', patch: { characterIds: ['loc-1'] } }],
      entSnap(),
    )
    expect(crossType.ok).toBe(false)
    expect(crossType.issues[0].message).toContain('地点')

    const crossLocation = validateAiBatch(
      [{ op: 'update_node', nodeId: 's1', patch: { locationId: 'ch-1' } }],
      entSnap(),
    )
    expect(crossLocation.ok).toBe(false)
    expect(crossLocation.issues[0].message).toContain('指向的是角色实体')

    const ghost = validateAiBatch(
      [{ op: 'update_node', nodeId: 's1', patch: { locationId: 'loc-404' } }],
      entSnap(),
    )
    expect(ghost.ok).toBe(false)
    expect(ghost.issues[0].message).toContain('地点实体不存在')

    const ghostSpeaker = validateAiBatch(
      [{
        op: 'update_node',
        nodeId: 'd1',
        patch: { lines: [{ kind: 'line', speaker: 'who', text: '？' }] },
      }],
      entSnap(),
    )
    expect(ghostSpeaker.ok).toBe(false)
    expect(ghostSpeaker.issues[0].message).toContain('角色实体不存在')

    const okExisting = validateAiBatch(
      [{ op: 'update_node', nodeId: 's1', patch: { characterIds: ['ch-1'], locationId: 'loc-1' } }],
      entSnap(),
    )
    expect(okExisting.ok).toBe(true)
  })
})

describe('validateAiBatch · ref 别名与同批先建后改（contingent 自愈，issue 44）', () => {
  it('失败 upsert 的 ref 依赖按 contingent 跳过：不产级联假阳性，修复后自愈', () => {
    const v = validateAiBatch(
      [
        { op: 'upsert_character', ref: 'hero', fields: { bio: '缺 name，失败' } },
        { op: 'update_node', nodeId: 's1', patch: { characterIds: ['hero'] } },
      ],
      entSnap(),
    )
    expect(v.ok).toBe(false)
    // 只有 upsert 自身被点名；依赖它的场景更新本轮跳过
    expect(v.issues).toHaveLength(1)
    expect(v.issues[0].index).toBe(0)

    const fixed = validateAiBatch(
      [
        { op: 'upsert_character', ref: 'hero', fields: { name: '林一' } },
        { op: 'update_node', nodeId: 's1', patch: { characterIds: ['hero'] } },
      ],
      entSnap(),
    )
    expect(fixed.ok).toBe(true)
  })

  it('同批 ref 别名既有实体：update 挂 ref 后，后续绑定可用 ref 引用', () => {
    const v = validateAiBatch(
      [
        { op: 'upsert_character', entityId: 'ch-1', ref: 'hero', fields: { bio: '补小传' } },
        { op: 'update_node', nodeId: 's1', patch: { characterIds: ['hero'] } },
      ],
      entSnap(),
    )
    expect(v.ok).toBe(true)
    expect(v.commands[0]).toMatchObject({ entityId: 'ch-1', ref: 'hero' })
  })

  it('修改本批新建实体（entityId 用 ref）：同批先建后改合法', () => {
    const v = validateAiBatch(
      [
        { op: 'upsert_character', ref: 'hero', fields: { name: '林一' } },
        { op: 'upsert_character', entityId: 'hero', fields: { bio: '侦探' } },
      ],
      entSnap(),
    )
    expect(v.ok).toBe(true)
    expect(v.items[1]).toMatchObject({ kind: 'update_entity' })
  })
})

describe('validateAiBatch · id 口径严格化（畸形 entityId / 独立 id 空间 / 虚拟 id 同形，issue 44）', () => {
  it('entityId 在场但畸形（非字符串/空白）整批拒绝，不重释为新建（与设计「新建不带 entityId」同口径）', () => {
    for (const bad of [
      { op: 'upsert_character', entityId: 123, fields: { name: '新名' } },
      { op: 'upsert_character', entityId: '', fields: { name: '新名' } },
      { op: 'upsert_character', entityId: '   ', fields: { name: '新名' } },
      { op: 'upsert_location', entityId: null, fields: { name: '公寓' } },
    ]) {
      const v = validateAiBatch([bad], entSnap())
      expect(v.ok, JSON.stringify(bad)).toBe(false)
      expect(v.issues[0].message).toContain('entityId')
      expect(v.commands).toEqual([])
    }
  })

  it('角色/地点同 id 共存（独立 id 空间）：引用按期望种类解析，不误判跨种类', () => {
    // §8.1：角色与地点是两个独立 id 空间，同 id 共存是合法状态
    const shared = 'dup-1'
    const sharedSnap: AiGraphSnapshot = {
      nodes: [{ id: 's1', type: 'scene', label: '场 01 · 茶馆' }],
      edges: [],
      assets: new Map(),
      settings: {
        characters: [{ id: shared, name: '陈默' }],
        locations: [{ id: shared, name: '茶馆' }],
      },
    }
    // locationId 指向共享 id：期望种类是 location，不得因角色桶先命中被误拒
    const asLocation = validateAiBatch(
      [{ op: 'update_node', nodeId: 's1', patch: { locationId: shared } }],
      sharedSnap,
    )
    expect(asLocation.ok).toBe(true)
    // characterIds 指向共享 id：同理按 character 解析
    const asCharacter = validateAiBatch(
      [{ op: 'update_node', nodeId: 's1', patch: { characterIds: [shared] } }],
      sharedSnap,
    )
    expect(asCharacter.ok).toBe(true)
  })

  it('持久化 id 与折叠虚拟 id 基形同形（__ent__:N）：投影 id 避开既有 id，引用不误判', () => {
    // 角色/地点 id 无保留前缀约束：持久化地点 id 可以恰好是 __ent__:0
    const snap: AiGraphSnapshot = {
      nodes: [{ id: 's1', type: 'scene', label: '场 01' }],
      edges: [],
      assets: new Map(),
      settings: {
        characters: [{ id: 'ch-1', name: '陈默' }],
        locations: [{ id: '__ent__:0', name: '奇怪地点' }],
      },
    }
    // 命令 0 新建角色后，__ent__:0 仍是持久化「地点」：写进 characterIds
    // 是跨种类误绑，不得因虚拟角色抢占桶位被放行（执行期会落盘悬空绑定）
    const asCharacter = validateAiBatch(
      [
        { op: 'upsert_character', ref: 'hero', fields: { name: '林一' } },
        { op: 'update_node', nodeId: 's1', patch: { characterIds: ['__ent__:0'] } },
      ],
      snap,
    )
    expect(asCharacter.ok).toBe(false)
    expect(asCharacter.issues[0].message).toContain('地点')
    // 同一 token 用在 locationId：指向持久化地点，合法
    const asLocation = validateAiBatch(
      [
        { op: 'upsert_character', ref: 'hero', fields: { name: '林一' } },
        { op: 'update_node', nodeId: 's1', patch: { locationId: '__ent__:0' } },
      ],
      snap,
    )
    expect(asLocation.ok).toBe(true)
  })
})

describe('validateAiBatch · 虚拟投影 id 不可直接引用（仅声明的 ref 可解析，issue 44）', () => {
  it('未经 ref 声明的 __ent__:N 写进引用位/entityId 均拒绝（执行层只解析别名表）', () => {
    const snap: AiGraphSnapshot = {
      nodes: [{ id: 's1', type: 'scene', label: '场 01' }],
      edges: [],
      assets: new Map(),
      settings: { characters: [], locations: [] },
    }
    // 命令 0 新建角色（无 ref，虚拟 id 为 __ent__:0）：该投影 id 不经 ref
    // 声明不可作为引用 token——放行会在执行期落盘悬空绑定
    const viaCharacterIds = validateAiBatch(
      [
        { op: 'upsert_character', fields: { name: '林一' } },
        { op: 'update_node', nodeId: 's1', patch: { characterIds: ['__ent__:0'] } },
      ],
      snap,
    )
    expect(viaCharacterIds.ok).toBe(false)
    expect(viaCharacterIds.issues[0].message).toContain('不存在')
    // entityId 直接指向投影 id 同样拒绝
    const viaEntityId = validateAiBatch(
      [
        { op: 'upsert_character', fields: { name: '林一' } },
        { op: 'upsert_character', entityId: '__ent__:0', fields: { bio: 'x' } },
      ],
      snap,
    )
    expect(viaEntityId.ok).toBe(false)
  })
})

describe('validateAiBatch · 台词行 speaker 引用与 ref 别名冲突（issue 44）', () => {
  it('缺省 kind 的台词行按 line 校验 speaker 引用（与归一化判别缺省同口径）', () => {
    const cross = validateAiBatch(
      [
        {
          op: 'create_node',
          nodeType: 'dialogue',
          data: { name: '对质', lines: [{ speaker: 'loc-1', text: '你来了。' }] },
        },
      ],
      entSnap(),
    )
    expect(cross.ok).toBe(false)
    expect(cross.issues.some((i) => i.message.includes('lines[0].speaker'))).toBe(true)

    const unknown = validateAiBatch(
      [
        {
          op: 'update_node',
          nodeId: 'd1',
          patch: { lines: [{ id: 'line-1', speaker: 'ghost-ch', text: '在。' }] },
        },
      ],
      entSnap(),
    )
    expect(unknown.ok).toBe(false)
    expect(unknown.issues.some((i) => i.message.includes('lines[0].speaker'))).toBe(true)
  })

  it('ref 别名与既有实体 id 冲突时整批拒绝（校验按既有实体解析、执行按别名解析）', () => {
    const v = validateAiBatch(
      [
        { op: 'upsert_character', ref: 'loc-1', fields: { name: '假名' } },
        { op: 'update_node', nodeId: 's1', patch: { locationId: 'loc-1' } },
      ],
      entSnap(),
    )
    expect(v.ok).toBe(false)
    expect(v.issues.some((i) => i.message.includes('ref 别名'))).toBe(true)

    // 修改既有实体挂冲突别名同样拒绝
    const onUpdate = validateAiBatch(
      [{ op: 'upsert_character', entityId: 'ch-1', ref: 'loc-1', fields: { bio: '补' } }],
      entSnap(),
    )
    expect(onUpdate.ok).toBe(false)
    expect(onUpdate.issues.some((i) => i.message.includes('ref 别名'))).toBe(true)
  })
})

describe('列表项稳定 id 归一化（S6479 信任边界：AI 可送旧形态，落画布前补 id）', () => {
  it('create_node 对白：无 id 的 lines 回填 line- 前缀 id；已有 id 原样保留（幂等）', () => {
    const v = validateAiBatch(
      [
        {
          op: 'create_node',
          nodeType: 'dialogue',
          data: {
            name: '摊牌',
            lines: [
              { kind: 'line', speaker: 'ch1', side: 'left', text: '别走' },
              { id: 'line-keep', kind: 'action', text: '雨声渐大' },
            ],
          },
        },
      ],
      snap(),
    )
    expect(v.ok).toBe(true)
    const cmd = v.commands[0] as { data: { lines: Array<{ id: string }> } }
    expect(cmd.data.lines[0].id).toMatch(/^line-/)
    expect(cmd.data.lines[1].id).toBe('line-keep')
  })

  it('create_node 分支：字符串选项升级为 {id,label}；缺 id 对象只补 id；已有 id 保留', () => {
    const v = validateAiBatch(
      [
        {
          op: 'create_node',
          nodeType: 'branch',
          data: { prompt: '追或不追？', options: ['追', { label: '不追' }, { id: 'opt-keep', label: '观望' }] },
        },
      ],
      snap(),
    )
    expect(v.ok).toBe(true)
    const cmd = v.commands[0] as { data: { options: Array<{ id: string; label: string }> } }
    expect(cmd.data.options.map((o) => o.label)).toEqual(['追', '不追', '观望'])
    expect(cmd.data.options[0].id).toMatch(/^opt-/)
    expect(cmd.data.options[1].id).toMatch(/^opt-/)
    expect(cmd.data.options[2].id).toBe('opt-keep')
  })

  it('create_node 分镜：refs 无 id 回填 ref- 前缀 id', () => {
    const v = validateAiBatch(
      [
        {
          op: 'create_node',
          nodeType: 'shot',
          data: { shotNo: 1, size: '中景', picture: '', prompt: '', refs: [{ kind: 'audio', label: '雨声' }] },
        },
      ],
      snap(),
    )
    expect(v.ok).toBe(true)
    const cmd = v.commands[0] as { data: { refs: Array<{ id: string }> } }
    expect(cmd.data.refs[0].id).toMatch(/^ref-/)
  })

  it('update_node 的 patch 按快照中既有节点类型同样归一化', () => {
    const s: AiGraphSnapshot = {
      nodes: [{ id: 'd9', type: 'dialogue', label: '对白 · 夜谈' }],
      edges: [],
      assets: new Map(),
    }
    const v = validateAiBatch(
      [{ op: 'update_node', nodeId: 'd9', patch: { lines: [{ kind: 'action', text: '沉默' }] } }],
      s,
    )
    expect(v.ok).toBe(true)
    const upd = v.commands[0]
    const lines =
      upd.op === 'update_node' && upd.patch.nodeType === 'dialogue'
        ? (upd.patch.patch.lines ?? [])
        : []
    expect(lines[0].id).toMatch(/^line-/)
  })

  it('重复或空串 id 不信任：列表内冲突/空白 id 重生成（React key 唯一性）', () => {
    const v = validateAiBatch(
      [
        {
          op: 'create_node',
          nodeType: 'dialogue',
          data: {
            name: '摊牌',
            lines: [
              { id: 'dup', kind: 'line', speaker: 'ch1', side: 'left', text: '一' },
              { id: 'dup', kind: 'line', speaker: 'ch1', side: 'left', text: '二' },
              { id: '', kind: 'action', text: '三' },
              { id: 'solo', kind: 'action', text: '四' },
              { id: '   ', kind: 'action', text: '五' },
            ],
          },
        },
        {
          op: 'create_node',
          nodeType: 'branch',
          data: { prompt: '？', options: [{ id: 'x', label: 'A' }, { id: 'x', label: 'B' }] },
        },
        {
          op: 'create_node',
          nodeType: 'shot',
          data: { shotNo: 1, size: '中景', picture: '', prompt: '', refs: [{ id: '', kind: 'audio', label: '雨声' }] },
        },
      ],
      snap(),
    )
    expect(v.ok).toBe(true)
    const lines = (v.commands[0] as unknown as { data: { lines: Array<{ id: string }> } }).data.lines
    const lineIds = lines.map((l) => l.id)
    expect(new Set(lineIds).size).toBe(5) // 全唯一
    expect(lineIds.every((id) => id !== '')).toBe(true)
    expect(lineIds[0]).toBe('dup') // 首个保留
    expect(lineIds[1]).toMatch(/^line-/) // 冲突重生成
    expect(lineIds[2]).toMatch(/^line-/) // 空串重生成
    expect(lineIds[3]).toBe('solo') // 无冲突原样
    // 纯空白 id（§8.1 trim 口径）：保留会让加载侧按空白 id 重发改写身份——
    // 被接受的命令不得自带重开即变的“稳定”身份
    expect(lineIds[4]).toMatch(/^line-/)

    const options = (v.commands[1] as unknown as { data: { options: Array<{ id: string }> } }).data.options
    expect(options[0].id).toBe('x')
    expect(options[1].id).toMatch(/^opt-/)

    const refs = (v.commands[2] as unknown as { data: { refs: Array<{ id: string }> } }).data.refs
    expect(refs[0].id).toMatch(/^ref-/)
  })
})

describe('wouldCreateCycle（连线防环，画布与批量共用）', () => {
  it('沿现有边回到 source 即成环，反之放行', () => {
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
    ]
    expect(wouldCreateCycle(edges, 'c', 'a')).toBe(true)
    expect(wouldCreateCycle(edges, 'a', 'c')).toBe(false)
  })
})

describe('参数字段校验（⚙️ 设置面板字段的 AI 通道）', () => {
  it('patch / data 的未知字段整批拒绝，并提示允许字段', () => {
    const v1 = validateAiBatch(
      [{ op: 'update_node', nodeId: 'n1', patch: { synopsis: '雨中分手', hacker: true } }],
      snap(),
    )
    expect(v1.ok).toBe(false)
    expect(v1.issues[0].message).toContain('synopsis')

    const v2 = validateAiBatch([{ op: 'create_node', nodeType: 'beat', data: { name: '转折', foo: 1 } }], snap())
    expect(v2.ok).toBe(false)
    expect(v2.issues[0].message).toContain('tone')
  })

  it('各类型合法字段通过（含场号/镜号改排 = 大纲级操作）', () => {
    const v = validateAiBatch(
      [
        { op: 'update_node', nodeId: 'n1', patch: { sceneNo: 3, time: '🌅 晨', characterIds: ['c1'] } },
        { op: 'create_node', nodeType: 'shot', data: { shotNo: 2, size: '特写', prompt: '雨水划过脸庞' } },
      ],
      snap(),
    )
    expect(v.ok).toBe(true)
  })

  it('episodeNo 分集：编剧侧四类可写，分镜卡不可写（随宿主场景）', () => {
    const ok = validateAiBatch(
      [
        { op: 'update_node', nodeId: 'n1', patch: { episodeNo: 1 } },
        { op: 'update_node', nodeId: 'n2', patch: { episodeNo: 1 } },
        { op: 'create_node', nodeType: 'dialogue', ref: 'd', data: { episodeNo: 2 } },
      ],
      snap(),
    )
    expect(ok.ok).toBe(true)

    const bad = validateAiBatch(
      [{ op: 'update_node', nodeId: 'n1', patch: { episodeNo: 0 } }],
      { ...snap(), nodes: [...snap().nodes, { id: 'x', type: 'shot', label: 'SHOT01' }] },
    )
    // n1 是 scene：字段可写但值域非法（§9.3 正整数）——零/负/小数拒绝
    expect(bad.ok).toBe(false)

    const shotBad = validateAiBatch(
      [{ op: 'update_node', nodeId: 'x', patch: { episodeNo: 1 } }],
      { ...snap(), nodes: [...snap().nodes, { id: 'x', type: 'shot', label: 'SHOT01' }] },
    )
    expect(shotBad.ok).toBe(false)
    expect(shotBad.issues[0].message).toContain('分镜')
  })
})

describe('分类型连线校验（剧情流 / 分支选项出口 / 分镜下挂）', () => {
  it('默认 sequence：普通节点间连线合法；分支 source 走 sequence 拒绝（§5 端口归属）', () => {
    const v = validateAiBatch([{ op: 'connect_edge', sourceId: 'n2', targetId: 'n1' }], { ...snap(), edges: [] })
    expect(v.ok).toBe(true)
    expect(v.commands[0]).toMatchObject({ edgeKind: 'sequence' })
    const fromBranch = validateAiBatch([{ op: 'connect_edge', sourceId: 'b1', targetId: 's1' }], richSnap())
    expect(fromBranch.ok).toBe(false)
  })

  it('attach 仅允许 场景 → 分镜（下挂），且不做环检测', () => {
    // 快照携带旧草案遗留的反向边（sh1→s1）：attach 是垂直派生边，即便快照
    // 中存在这样的横向路径也不参与环检测——但批次不得再新建分镜端点的剧情流边
    const ok = validateAiBatch(
      [{ op: 'connect_edge', sourceId: 's1', targetId: 'sh1', edgeKind: 'attach' }],
      { ...richSnap(), edges: [{ source: 'sh1', target: 's1' }] },
    )
    expect(ok.ok).toBe(true)
    expect(ok.commands[0]).toMatchObject({ edgeKind: 'attach' })

    for (const bad of [
      { op: 'connect_edge', sourceId: 'sh1', targetId: 's1', edgeKind: 'attach' },
      { op: 'connect_edge', sourceId: 'b1', targetId: 'sh1', edgeKind: 'attach' },
    ]) {
      const v = validateAiBatch([bad], richSnap())
      expect(v.ok, JSON.stringify(bad)).toBe(false)
    }
  })

  it('update_node 删选项连带从校验快照移除其出口边：不误判成环（§8.2.2）', () => {
    const snap = richSnap()
    // 现有边：b1 --option-ob-a--> s1。批次：删选项 ob-a，再连 s1 → b1。
    // 若校验态不清除被删选项的边，BFS 会把 s1→b1 误判为成环而拒绝合法批次。
    const snapWithEdge: AiGraphSnapshot = {
      ...snap,
      edges: [{ source: 'b1', target: 's1', sourceHandle: 'option-ob-a', type: 'branch' }],
    }
    const v = validateAiBatch(
      [
        { op: 'update_node', nodeId: 'b1', patch: { options: [{ id: 'ob-b', label: '不追' }] } },
        { op: 'connect_edge', sourceId: 's1', targetId: 'b1' },
      ],
      snapWithEdge,
    )
    expect(v.ok, JSON.stringify(v.issues)).toBe(true)
  })

  it('branch 需要来源为分支节点且 optionIndex 在选项范围内', () => {
    const ok = validateAiBatch(
      [{ op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 1 }],
      richSnap(),
    )
    expect(ok.ok).toBe(true)
    expect(ok.commands[0]).toMatchObject({ edgeKind: 'branch', optionIndex: 1 })

    for (const bad of [
      { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch' },
      { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 2 },
      { op: 'connect_edge', sourceId: 's1', targetId: 'sh1', edgeKind: 'branch', optionIndex: 0 },
    ]) {
      const v = validateAiBatch([bad], richSnap())
      expect(v.ok, JSON.stringify(bad)).toBe(false)
    }
  })

  it('同一 option 端口的重复连线拒绝；不同选项各自可达', () => {
    const v = validateAiBatch(
      [
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 0 },
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 0 },
      ],
      richSnap(),
    )
    expect(v.ok).toBe(false)
    expect(v.issues[0].message).toContain('重复')

    const ok = validateAiBatch(
      [
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 0 },
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 1 },
      ],
      richSnap(),
    )
    expect(ok.ok).toBe(true)
  })

  it('端点断线移除全部同端点虚拟边：反向连线不因残留边误报成环（评审 5164943585）', () => {
    // 断线命令无端口参数，执行通道按端点对移除全部同端点边（batchSim 的
    // forward 过滤同语义）：两条不同选项出口边一并清除，校验态须同口径，
    // 否则反向剧情流连线被残留边误判成环
    const v = validateAiBatch(
      [
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 0 },
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 1 },
        { op: 'disconnect_edge', sourceId: 'b1', targetId: 's1' },
        { op: 'connect_edge', sourceId: 's1', targetId: 'b1' },
      ],
      richSnap(),
    )
    expect(v.ok, JSON.stringify(v.issues)).toBe(true)
    expect(v.commands).toHaveLength(4)
  })

  it('同对节点的 sequence 涉及分镜卡：拒绝——attach 才是场景↔分镜的唯一连线', () => {
    const v = validateAiBatch(
      [{ op: 'connect_edge', sourceId: 's1', targetId: 'sh1', edgeKind: 'sequence' }],
      richSnap(),
    )
    expect(v.ok).toBe(false)
    expect(v.issues[0].message).toContain('分镜')
  })
})

describe('validateAiBatch：分支 options 级联簿记前的成员形状校验（信任边界）', () => {
  it('update_node 的 options 含异型成员（null / 缺 label）：整批拒绝而非抛异常', () => {
    const withNull = validateAiBatch(
      [{ op: 'update_node', nodeId: 'b1', patch: { options: [null] } }],
      richSnap(),
    )
    expect(withNull.ok).toBe(false)
    const noLabel = validateAiBatch(
      [{ op: 'update_node', nodeId: 'b1', patch: { options: [{ id: 'o1' }] } }],
      richSnap(),
    )
    expect(noLabel.ok).toBe(false)
  })

  it('create_node 的 options 含异型成员：整批拒绝；字符串选项与完整成员仍放行', () => {
    const bad = validateAiBatch(
      [{ op: 'create_node', nodeType: 'branch', data: { prompt: '？', options: [42] } }],
      richSnap(),
    )
    expect(bad.ok).toBe(false)
    const good = validateAiBatch(
      [
        {
          op: 'create_node',
          nodeType: 'branch',
            data: { prompt: '？', options: ['徒手', { id: 'o2', label: '叫人' }] },
        },
      ],
      richSnap(),
    )
    expect(good.ok).toBe(true)
  })

  // 契约 token 断言：issue #46 的验收标准要求错误信息指名 `options`
  // （不锁定具体措辞，避免无害文案编辑破坏套件）。
  it('options 非数组（issue 46）：update 与 create 整批拒绝并点名 options，不得直抵画布', () => {
    const update = validateAiBatch(
      [{ op: 'update_node', nodeId: 'b1', patch: { options: 'foo' } }],
      richSnap(),
    )
    expect(update.ok).toBe(false)
    expect(update.commands).toEqual([])
    expect(update.issues[0]?.message).toContain('options')

    const create = validateAiBatch(
      [{ op: 'create_node', nodeType: 'branch', data: { prompt: '？', options: 42 } }],
      richSnap(),
    )
    expect(create.ok).toBe(false)
    expect(create.commands).toEqual([])
    expect(create.issues[0]?.message).toContain('options')
  })

  it('经 ref 的 update 携非数组 options：随 create 修复重放在阶段 B 点名（分层）', () => {
    const v = validateAiBatch(
      [
        { op: 'create_node', nodeType: 'branch', ref: 'nb', data: { prompt: '？', options: [{ label: 5 }] } },
        { op: 'update_node', nodeId: 'nb', patch: { options: {} } },
      ],
      richSnap(),
    )
    // 两阶段契约（owner 批准）：create 形状失败 → 阶段 B 不运行，update 的
    // 类型专属错误分层延后，不诱导模型在首轮改写它
    expect(v.ok).toBe(false)
    expect(v.issues).toHaveLength(1)
    expect(v.issues[0]?.index).toBe(0)

    const repaired = validateAiBatch(
      [
        { op: 'create_node', nodeType: 'branch', ref: 'nb', data: { prompt: '？', options: ['追'] } },
        { op: 'update_node', nodeId: 'nb', patch: { options: {} } },
      ],
      richSnap(),
    )
    expect(repaired.ok).toBe(false)
    expect(repaired.issues.some((i) => i.index === 1 && i.message.includes('options'))).toBe(true)
  })

  it('非数组 options 更新失败同样登记 contingent（评审 5163172679）：越界连线不点名', () => {
    const v = validateAiBatch(
      [
        { op: 'update_node', nodeId: 'b1', patch: { options: 'foo' } },
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 2 },
      ],
      richSnap(),
    )
    expect(v.ok).toBe(false)
    expect(v.issues).toHaveLength(1)
    expect(v.issues[0]?.message).toContain('options')
    expect(v.issues.map((i) => i.message).join('\n')).not.toContain('optionIndex')
  })
})

describe('AI 批量命令的逐类型载荷形状校验（信任边界：字段键白名单之外的值形状）', () => {
  it('shot 的 picture 非字符串 / refs 含 null：整批拒绝并给出字段级诊断', () => {
    const bad = validateAiBatch(
      [
        {
          op: 'create_node',
          nodeType: 'shot',
          data: { shotNo: 1, size: '特写', picture: {}, prompt: '', refs: [null] },
        },
      ],
      snap(),
    )
    expect(bad.ok).toBe(false)
    const msg = bad.issues.map((i) => i.message).join('\n')
    expect(msg).toContain('picture')
    expect(msg).toContain('refs')
  })

  it('scene 的标量/列表形状：interior 非布尔、characterIds 含非字符串成员均拒绝', () => {
    const bad = validateAiBatch(
      [
        { op: 'create_node', nodeType: 'scene', data: { name: '场', sceneNo: 1, interior: 'yes', characterIds: ['ch-1', 7] } },
      ],
      snap(),
    )
    expect(bad.ok).toBe(false)
    const msg = bad.issues.map((i) => i.message).join('\n')
    expect(msg).toContain('interior')
    expect(msg).toContain('characterIds')
  })

  it('dialogue 的 lines 成员须为带字符串 text 的对象；update patch 同域校验', () => {
    const badCreate = validateAiBatch(
      [{ op: 'create_node', nodeType: 'dialogue', data: { name: '对白', lines: [{ id: 'l1', kind: 'line', speaker: '', text: 42 }] } }],
      snap(),
    )
    expect(badCreate.ok).toBe(false)
    expect(badCreate.issues.map((i) => i.message).join('\n')).toContain('lines')

    const badUpdate = validateAiBatch(
      [{ op: 'update_node', nodeId: 'n1', patch: { synopsis: {} } }],
      snap(),
    )
    expect(badUpdate.ok).toBe(false)
    expect(badUpdate.issues.map((i) => i.message).join('\n')).toContain('synopsis')
  })

  it('action 台词行携带 speaker：拒绝（隐藏引用不得进活动文档并持久化）', () => {
    const bad = validateAiBatch(
      [{ op: 'create_node', nodeType: 'dialogue', data: { name: '对白', lines: [{ id: 'l1', kind: 'action', speaker: 'ch1', text: '雨声渐大' }] } }],
      snap(),
    )
    expect(bad.ok).toBe(false)
    expect(bad.issues.map((i) => i.message).join('\n')).toContain('lines')
  })

  it('shot refs 成员违反引用位联合（kind 未知 / assetId 与 label 并存）：拒绝', () => {
    const bad = validateAiBatch(
      [
        {
          op: 'create_node',
          nodeType: 'shot',
          data: {
            shotNo: 1, size: '特写', picture: '', prompt: '',
            refs: [
              { id: 'r1', kind: 'ghost', label: '异灵' },
              { id: 'r2', kind: 'audio', assetId: 'a-1', label: '并存' },
            ],
          },
        },
      ],
      snap(),
    )
    expect(bad.ok).toBe(false)
    expect(bad.issues.map((i) => i.message).join('\n')).toContain('refs')
  })

  it('shot refs 的 assetId 为空白字符串：拒绝（空串是 string 但不可解析，装上即永久悬空引用）', () => {
    const bad = validateAiBatch(
      [
        {
          op: 'create_node',
          nodeType: 'shot',
          data: {
            shotNo: 1, size: '特写', picture: '', prompt: '',
            refs: [
              { id: 'r1', kind: 'audio', assetId: '' },
              { id: 'r2', kind: 'audio', assetId: '  ' },
            ],
          },
        },
      ],
      snap(),
    )
    expect(bad.ok).toBe(false)
    expect(bad.issues.map((i) => i.message).join('\n')).toContain('refs')
  })

  it('shot refs 引用位：assetId 须命中快照资产且 MIME 家族匹配用途（§7.1/§11.3 对等）', () => {
    const shotWith = (refs: unknown[]) => [
      {
        op: 'create_node',
        nodeType: 'shot',
        data: { shotNo: 1, size: '中景', picture: '', prompt: '', refs },
      },
    ]
    const good = validateAiBatch(
      shotWith([
        { id: 'r1', kind: 'character', assetId: 'a-img' },
        { id: 'r2', kind: 'audio', assetId: 'a-aud' },
      ]),
      richSnap(),
    )
    expect(good.ok).toBe(true)

    const mismatch = validateAiBatch(
      shotWith([{ id: 'r1', kind: 'audio', assetId: 'a-img' }]),
      richSnap(),
    )
    expect(mismatch.ok).toBe(false)
    expect(mismatch.issues[0].message).toContain('a-img')
    expect(mismatch.issues[0].message).toContain('用途不匹配')

    const ghost = validateAiBatch(
      shotWith([{ id: 'r1', kind: 'character', assetId: 'ghost' }]),
      richSnap(),
    )
    expect(ghost.ok).toBe(false)
    expect(ghost.issues[0].message).toContain('ghost')
    expect(ghost.issues[0].message).toContain('不存在')

    // 快照无资产（空索引）：引用位无目标可解析，一律拒绝（AI 只能改用自由位）
    const noAssets = validateAiBatch(
      shotWith([{ id: 'r1', kind: 'character', assetId: 'a-img' }]),
      snap(),
    )
    expect(noAssets.ok).toBe(false)
    expect(noAssets.issues[0].message).toContain('不存在')
  })

  it('选项替换的级联断线进预览并触发删除级确认：一键不得静默删除剧情路径', () => {
    const snapWithEdge = (): AiGraphSnapshot => ({
      ...richSnap(),
      edges: [{ source: 'b1', target: 's1', sourceHandle: 'option-ob-a', type: 'branch' }],
    })
    // 显式合法 id 的替换对象：被换选项（ob-a/ob-b）的引出边会被级联删除
    const v = validateAiBatch(
      [
        {
          op: 'update_node',
          nodeId: 'b1',
          patch: { options: [{ id: 'replacement', label: '新选项' }] },
        },
      ],
      snapWithEdge(),
    )
    expect(v.ok).toBe(true)
    // 红：预览只有普通"修改"项——hasDeletes=false，一键确认静默删除连线
    expect(v.items.some((i) => i.kind === 'disconnect' && i.danger)).toBe(true)
    expect(v.hasDeletes).toBe(true)
    expect(v.items[0].danger).toBe(true) // 危险项置顶（§6）

    // 对照：显式 disconnect_edge（用户主动断开）仍为普通确认
    const explicit = validateAiBatch(
      [{ op: 'disconnect_edge', sourceId: 'b1', targetId: 's1' }],
      snapWithEdge(),
    )
    expect(explicit.hasDeletes).toBe(false)
  })

  it('update_node 的无 id 对象简写同款按位复用既有稳定 id（孪生路径）', () => {
    // 红：id-less 对象被 normalizeIds 整体发新 id——全部既有 option- 句柄
    // 被视为已删选项，引出连线被静默清除
    const v = validateAiBatch(
      [
        {
          op: 'update_node',
          nodeId: 'b1',
          patch: { options: [{ label: '追！' }, { label: '不追' }] },
        },
      ],
      richSnap(),
    )
    expect(v.ok).toBe(true)
    const options =
      v.commands[0].op === 'update_node' && v.commands[0].patch.nodeType === 'branch'
        ? (v.commands[0].patch.patch.options ?? [])
        : []
    expect(options).toEqual([
      { id: 'ob-a', label: '追！' },
      { id: 'ob-b', label: '不追' },
    ])

    // 混合形态：字符串与无 id 对象都按位绑定，显式合法 id 的对象保留自报 id
    const mixed = validateAiBatch(
      [
        {
          op: 'update_node',
          nodeId: 'b1',
          patch: { options: ['追！', { label: '不追' }, { id: 'ob-x', label: '新选项' }] },
        },
      ],
      richSnap(),
    )
    const mixedOptions =
      mixed.commands[0].op === 'update_node' && mixed.commands[0].patch.nodeType === 'branch'
        ? (mixed.commands[0].patch.patch.options ?? [])
        : []
    expect(mixedOptions.map((o) => o.id)).toEqual(['ob-a', 'ob-b', 'ob-x'])
  })

  it('update_node 的字符串选项按位置复用既有稳定 id：重命名不清空引出连线', () => {
    // 红：字符串形态整体重发新 id——全部既有 option- 句柄被视为已删选项，
    // 折叠/模拟静默清除每条引出线，而预览只显示一次普通选项更新
    const v = validateAiBatch(
      [{ op: 'update_node', nodeId: 'b1', patch: { options: ['追！', '不追'] } }],
      richSnap(),
    )
    expect(v.ok).toBe(true)
    const options =
      v.commands[0].op === 'update_node' && v.commands[0].patch.nodeType === 'branch'
        ? (v.commands[0].patch.patch.options ?? [])
        : []
    expect(options).toEqual([
      { id: 'ob-a', label: '追！' },
      { id: 'ob-b', label: '不追' },
    ])
    // 超出现有选项数的字符串仍是新增（发新 id）
    const grown = validateAiBatch(
      [{ op: 'update_node', nodeId: 'b1', patch: { options: ['追！', '不追', '再想想'] } }],
      richSnap(),
    )
    const grownOptions =
      grown.commands[0].op === 'update_node' && grown.commands[0].patch.nodeType === 'branch'
        ? (grown.commands[0].patch.patch.options ?? [])
        : []
    expect(grownOptions[0].id).toBe('ob-a')
    expect(grownOptions[2].id).toMatch(/^opt-/)
  })

  it('对白行 speaker 空白域拒收：加载侧会移除该值——接受的 AI 改动不得重开即变样', () => {
    const snapWithDialogue = (): AiGraphSnapshot => ({
      ...snap(),
      nodes: [...snap().nodes, { id: 'd9', type: 'dialogue', label: '对白 · 夜谈' }],
    })
    // 红：只查值类型——空白 speaker 进画布落盘，下次加载被归一化移除
    const bad = validateAiBatch(
      [
        {
          op: 'update_node',
          nodeId: 'd9',
          patch: { lines: [{ kind: 'line', text: '别走', speaker: '   ' }] },
        },
      ],
      snapWithDialogue(),
    )
    expect(bad.ok).toBe(false)
    expect(bad.issues[0].message).toContain('speaker')

    const good = validateAiBatch(
      [
        {
          op: 'update_node',
          nodeId: 'd9',
          patch: { lines: [{ kind: 'line', text: '别走', speaker: 'ch-1' }] },
        },
      ],
      snapWithDialogue(),
    )
    expect(good.ok).toBe(true)
  })

  it('scene 引用字段空白域拒收：characterIds 成员与 locationId 须 trim 后非空（§8.1 同域）', () => {
    const sceneWith = (patch: Record<string, unknown>) => [
      { op: 'update_node', nodeId: 's1', patch },
    ]
    // 红：只查成员类型——空白引用进画布落盘，下次加载被归一化移除，
    // 接受过的 AI 改动重开即变样
    const badIds = validateAiBatch(sceneWith({ characterIds: ['ch-1', '   '] }), richSnap())
    expect(badIds.ok).toBe(false)
    expect(badIds.issues[0].message).toContain('characterIds')

    const badLoc = validateAiBatch(sceneWith({ locationId: '  ' }), richSnap())
    expect(badLoc.ok).toBe(false)
    expect(badLoc.issues[0].message).toContain('locationId')

    const good = validateAiBatch(sceneWith({ characterIds: ['ch-1'] }), richSnap())
    expect(good.ok).toBe(true)
  })

  it('update_node 的 refs 同款资产校验（patch 路径与 create 同一信任边界）', () => {
    const bad = validateAiBatch(
      [
        {
          op: 'update_node',
          nodeId: 'sh1',
          patch: { refs: [{ id: 'r1', kind: 'location', assetId: 'a-aud' }] },
        },
      ],
      richSnap(),
    )
    expect(bad.ok).toBe(false)
    expect(bad.issues[0].message).toContain('用途不匹配')
  })

  it('合法载荷照常通过（不因形状校验收紧而误拒）', () => {
    const good = validateAiBatch(
      [
        {
          op: 'create_node',
          nodeType: 'shot',
          data: { shotNo: 2, size: '全景', picture: '夜景街道', prompt: '雨夜', refs: [{ kind: 'audio', label: '雨声' }] },
        },
      ],
      snap(),
    )
    expect(good.ok).toBe(true)
  })
})

describe('对白行判别字段与可选字段（信任边界：不被下次加载静默删除）', () => {
  it('kind 非 line/action 拒绝；缺省 kind 归一为 line', () => {
    const bad = validateAiBatch(
      [{ op: 'create_node', nodeType: 'dialogue', data: { name: '对白', lines: [{ id: 'l1', kind: 'narration', text: '旁白' }] } }],
      snap(),
    )
    expect(bad.ok).toBe(false)
    expect(bad.issues.map((i) => i.message).join('\n')).toContain('lines')

    const ok = validateAiBatch(
      [{ op: 'create_node', nodeType: 'dialogue', ref: 'd', data: { name: '对白', lines: [{ text: '台词' }, { kind: 'action', text: '转身' }] } }],
      snap(),
    )
    expect(ok.ok).toBe(true)
    const cmd = ok.commands[0] as { data: { lines: Array<{ kind: string }> } }
    expect(cmd.data.lines[0].kind).toBe('line')
    expect(cmd.data.lines[1].kind).toBe('action')
  })

  it('可选字段 side/vo 异型拒绝', () => {
    const bad = validateAiBatch(
      [{ op: 'create_node', nodeType: 'dialogue', data: { name: '对白', lines: [{ kind: 'line', text: 'x', side: 'middle', vo: 1 }] } }],
      snap(),
    )
    expect(bad.ok).toBe(false)
    expect(bad.issues.map((i) => i.message).join('\n')).toContain('lines')
  })
})

describe('attach 宿主唯一（§5：交互/AI 侧对等，不留「重开即消失」的连线）', () => {
  it('目标分镜已有入向 attach：拒绝第二条；断开+重连（换宿主）同批合法', () => {
    const snapWithHost: AiGraphSnapshot = {
      ...richSnap(),
      nodes: [...richSnap().nodes, { id: 's9', type: 'scene', label: '场 09' }],
      edges: [{ source: 's9', target: 'sh1', sourceHandle: 'shots' }],
    }
    const bad = validateAiBatch(
      [{ op: 'connect_edge', sourceId: 's1', targetId: 'sh1', edgeKind: 'attach' }],
      snapWithHost,
    )
    expect(bad.ok).toBe(false)
    expect(bad.issues[0].message).toContain('宿主')

    const rehost = validateAiBatch(
      [
        { op: 'disconnect_edge', sourceId: 's9', targetId: 'sh1' },
        { op: 'connect_edge', sourceId: 's1', targetId: 'sh1', edgeKind: 'attach' },
      ],
      snapWithHost,
    )
    expect(rehost.ok, JSON.stringify(rehost.issues)).toBe(true)
  })
})

describe('ShotRef 双字段并存（§4.2 联合的键在场判定）', () => {
  it('assetId 与 label 同时在场（即使 label 非字符串）：拒绝，不得交给加载侧静默删除', () => {
    const bad = validateAiBatch(
      [
        {
          op: 'create_node',
          nodeType: 'shot',
          data: { shotNo: 1, size: '特写', picture: '', prompt: '', refs: [{ kind: 'audio', assetId: 'a1', label: 5 }] },
        },
      ],
      snap(),
    )
    expect(bad.ok).toBe(false)
    expect(bad.issues.map((i) => i.message).join('\n')).toContain('refs')
  })
})

describe('AI 数值域（§9.3 命令边界：正安全整数，加载不静默改写）', () => {
  it('sceneNo 1.5 / shotNo -2 / episodeNo 0 均拒绝', () => {
    const bad1 = validateAiBatch(
      [{ op: 'create_node', nodeType: 'scene', data: { name: '场', sceneNo: 1.5 } }],
      snap(),
    )
    expect(bad1.ok).toBe(false)
    expect(bad1.issues.map((i) => i.message).join('\n')).toContain('sceneNo')
    const bad2 = validateAiBatch(
      [{ op: 'create_node', nodeType: 'shot', data: { shotNo: -2, size: '特写', picture: '', prompt: '' } }],
      snap(),
    )
    expect(bad2.ok).toBe(false)
    expect(bad2.issues.map((i) => i.message).join('\n')).toContain('shotNo')
    const bad3 = validateAiBatch(
      [{ op: 'update_node', nodeId: 'n1', patch: { episodeNo: 0 } }],
      snap(),
    )
    expect(bad3.ok).toBe(false)
    expect(bad3.issues.map((i) => i.message).join('\n')).toContain('episodeNo')
  })
})

describe('图片节点的 AI 命令边界（§13 首版：快照只读可见、不创建/不修改）', () => {
  it('update_node 目标为图片节点：整批拒绝', () => {
    const s: AiGraphSnapshot = {
      nodes: [
        { id: 'n1', type: 'scene', label: '场 01 · 天台' },
        { id: 'img1', type: 'image', label: '图片 · 雨夜霓虹' },
      ],
      edges: [],
      assets: new Map(),
    }
    const bad = validateAiBatch(
      [{ op: 'update_node', nodeId: 'img1', patch: { prompt: {} } }],
      s,
    )
    expect(bad.ok).toBe(false)
    expect(bad.issues.map((i) => i.message).join('\n')).toContain('暂不支持 AI 命令修改')
  })

  it('create_node 声明 image 类型：按未知节点类型拒绝（类型标签表未含）', () => {
    const bad = validateAiBatch(
      [{ op: 'create_node', nodeType: 'image', data: { prompt: 'x' } }],
      snap(),
    )
    expect(bad.ok).toBe(false)
    expect(bad.issues.map((i) => i.message).join('\n')).toContain('未知节点类型')
  })

  it('delete_node 目标为图片节点：整批拒绝（与 create/update 同口径）', () => {
    const s: AiGraphSnapshot = {
      nodes: [
        { id: 'n1', type: 'scene', label: '场 01 · 天台' },
        { id: 'img1', type: 'image', label: '图片 · 雨夜霓虹' },
      ],
      edges: [],
      assets: new Map(),
    }
    const bad = validateAiBatch([{ op: 'delete_node', nodeId: 'img1' }], s)
    expect(bad.ok).toBe(false)
    expect(bad.issues.map((i) => i.message).join('\n')).toContain('暂不支持 AI 命令删除')
  })
})

describe('validateAiBatch：完整问题收集（评审 5138829847：纠错回喂依赖全量清单）', () => {
  it('多个独立非法命令逐条收集问题，不再首错短路；原子性保持', () => {
    const v = validateAiBatch(
      [
        { op: 'create_node', nodeType: 'beat', data: { label: '立足' } },
        { op: 'create_node', nodeType: 'beat', data: { summary: '小店开张' } },
        { op: 'no_such_op', nodeId: 'x' },
      ],
      snap(),
    )
    expect(v.ok).toBe(false)
    expect(v.commands).toEqual([])
    expect(v.issues).toHaveLength(3)
    expect(v.issues.map((i) => i.index)).toEqual([0, 1, 2])
    expect(v.issues[0]?.message).toContain('label')
    expect(v.issues[1]?.message).toContain('summary')
    expect(v.issues[2]?.message).toContain('未知操作')
  })

  it('依赖失败 create 的引用命令按 contingent 跳过，不产生级联假阳性', () => {
    const v = validateAiBatch(
      [
        { op: 'create_node', nodeType: 'beat', data: { label: '立足' }, ref: 'b' },
        { op: 'connect_edge', sourceId: 'b', targetId: 'n1' },
      ],
      snap(),
    )
    expect(v.ok).toBe(false)
    expect(v.commands).toEqual([])
    // 只点名 create 自身的字段错误；修复后依赖命令自愈，不诱导模型改写
    expect(v.issues).toHaveLength(1)
    expect(v.issues[0]?.message).toContain('label')
    expect(v.issues.map((i) => i.message).join('\n')).not.toContain('端点不存在')
  })

  it('前序形状失败时其后的真实缺失分层延后：修复重放后独立点名', () => {
    const v = validateAiBatch(
      [
        { op: 'create_node', nodeType: 'beat', data: { label: '立足' }, ref: 'b' },
        { op: 'connect_edge', sourceId: 'zz', targetId: 'n1' },
      ],
      snap(),
    )
    // 阶段 B 首错即停：create 失败 → connect 本轮不校验（分层，契约变更）
    expect(v.issues).toHaveLength(1)
    expect(v.issues[0]?.message).toContain('label')

    const repaired = validateAiBatch(
      [
        { op: 'create_node', nodeType: 'beat', data: { name: '立足' }, ref: 'b' },
        { op: 'connect_edge', sourceId: 'zz', targetId: 'n1' },
      ],
      snap(),
    )
    // 拒绝语义按命令定位断言（评审 5174231991：诊断措辞不作契约）
    expect(repaired.ok).toBe(false)
    expect(repaired.issues).toHaveLength(1)
    expect(repaired.issues[0]?.index).toBe(1)
  })

  it('阶段 A 命中即整批拒绝：不折叠任何命令、不产预览项（原子性）', () => {
    const v = validateAiBatch(
      [
        { op: 'create_node', nodeType: 'beat', data: { summary: '小店开张' }, ref: 'b' },
        { op: 'update_node', nodeId: 'b', patch: { tone: '紧凑' } },
        { op: 'update_node', nodeId: 'n1', patch: { time: '🌅 晨' } },
        { op: 'delete_node', nodeId: 'n2' },
      ],
      snap(),
    )
    expect(v.ok).toBe(false)
    // 两阶段契约：形状失败 → 阶段 B 不运行，本轮零折叠、零预览项
    expect(v.issues).toHaveLength(1)
    expect(v.issues[0]?.message).toContain('summary')
    expect(v.items).toEqual([])
    expect(v.commands).toEqual([])
  })
})

// 两阶段校验（owner 批准的契约变更）：阶段 A 逐条收集上下文无关的形状
// 错误（白名单/值形状/options 成员/连线类型/内在 optionIndex/entityId 与
// fields 形态），一次全量回喂——quota 按轮消耗，多错误批次一轮修完；
// 阶段 B 在形状全过后顺序折叠，首错即停——失败之后的命令本轮不校验、
// 不点名，级联误报由「不前进」消除，分层错误随修复重放逐轮暴露。
describe('validateAiBatch：两阶段校验（阶段 A 全量形状 + 阶段 B 首错即停）', () => {
  it('阶段 A 全量收集形状错误：多命令一次点名，依赖命令不级联', () => {
    const v = validateAiBatch(
      [
        { op: 'create_node', nodeType: 'branch', ref: 'nb', data: { prompt: '？', options: 42 } },
        { op: 'update_node', nodeId: 'b1', patch: { nope: 1 } },
        { op: 'connect_edge', sourceId: 'nb', targetId: 's1' },
      ],
      richSnap(),
    )
    expect(v.ok).toBe(false)
    expect(v.commands).toEqual([])
    // create 与 update 的形状错误全量点名；connect 依赖失败 create，
    // 阶段 B 不运行、不产生「端点不存在」级联
    expect(v.issues.map((i) => i.index)).toEqual([0, 1])
  })

  it('连线类型与内在 optionIndex 属阶段 A：与形状错误同轮全量点名', () => {
    const v = validateAiBatch(
      [
        { op: 'create_node', nodeType: 'branch', ref: 'nb', data: { prompt: '？', options: 42 } },
        { op: 'connect_edge', sourceId: 'nb', targetId: 's1', edgeKind: 'weird' },
        { op: 'connect_edge', sourceId: 'nb', targetId: 's1', edgeKind: 'branch', optionIndex: -1 },
      ],
      richSnap(),
    )
    expect(v.issues.map((i) => i.index)).toEqual([0, 1, 2])
  })

  it('阶段 B 首错即停：独立结构错误只报首条，其余本轮不校验', () => {
    const v = validateAiBatch(
      [
        { op: 'connect_edge', sourceId: 'n1', targetId: 'ghost-a' },
        { op: 'connect_edge', sourceId: 'n2', targetId: 'ghost-b' },
      ],
      snap(),
    )
    expect(v.ok).toBe(false)
    expect(v.issues).toHaveLength(1)
    expect(v.issues[0]?.index).toBe(0)
  })

  it('create 形状失败时，经 ref 的 update 类型专属错误分层延后（首轮不点名）', () => {
    const v = validateAiBatch(
      [
        { op: 'create_node', nodeType: 'branch', ref: 'nb', data: { prompt: '？', options: 42 } },
        { op: 'update_node', nodeId: 'nb', patch: { prompt: 5 } },
      ],
      richSnap(),
    )
    // prompt 属可写类型字段的并集：阶段 A 不按未知类型点名；类型专属的
    // 值形状错误随修复重放在阶段 B 点名（分层暴露，契约变更决策）
    expect(v.issues).toHaveLength(1)
    expect(v.issues[0]?.index).toBe(0)
  })

  it('实体 upsert 的 fields 形状错误属阶段 A：全量点名', () => {
    const v = validateAiBatch(
      [
        { op: 'upsert_character', fields: { name: 5 } },
        { op: 'upsert_location', fields: { nope: 'x' } },
      ],
      entSnap(),
    )
    expect(v.ok).toBe(false)
    expect(v.issues.map((i) => i.index)).toEqual([0, 1])
  })

  it('前序 delete + 同名 ref 重建换主：update 类型专属检查让位阶段 B（评审 5174231991）', () => {
    const snapWithX: AiGraphSnapshot = {
      nodes: [{ id: 'x', type: 'scene', label: '场 01' }],
      edges: [],
      assets: new Map(),
    }
    const v = validateAiBatch(
      [
        { op: 'delete_node', nodeId: 'x' },
        { op: 'create_node', nodeType: 'beat', ref: 'x', data: { name: '立足' } },
        { op: 'update_node', nodeId: 'x', patch: { tone: '紧凑' } },
      ],
      snapWithX,
    )
    // 顺序语义：x 被删后由同名 ref 重建为 beat，tone 是 beat 合法字段——
    // 阶段 A 的快照类型已过期，不得按 scene 拒绝合法批次
    expect(v.ok).toBe(true)
    expect(v.commands).toHaveLength(3)
  })

  it('delete 在后的 update 仍按快照类型全量点名（对照）', () => {
    const v = validateAiBatch(
      [
        { op: 'update_node', nodeId: 's1', patch: { nope: 1 } },
        { op: 'delete_node', nodeId: 'sh1' },
      ],
      richSnap(),
    )
    expect(v.ok).toBe(false)
    expect(v.issues.map((i) => i.index)).toEqual([0])
  })

  it('删除只按 token 降级：无关 update 的类型错误仍进阶段 A 聚合（评审 5174367120）', () => {
    const v = validateAiBatch(
      [
        { op: 'delete_node', nodeId: 'sh1' },
        { op: 'update_node', nodeId: 'b1', patch: { tone: '紧凑' } },
        { op: 'update_node', nodeId: 's1', patch: { prompt: '？' } },
      ],
      richSnap(),
    )
    // tone/prompt 各自不是目标类型的字段：与被删 sh1 无关的 update 不随
    // 全局降级——阶段 A 一次点名两条（全局开关会把它们变成每轮一条的
    // 串行发现，配额可在第四条错误前耗尽）
    expect(v.ok).toBe(false)
    expect(v.issues.map((i) => i.index)).toEqual([1, 2])
  })
})
