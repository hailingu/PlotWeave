import { describe, expect, it } from 'vitest'
import { validateAiBatch } from './batchFold'
import type { AiGraphSnapshot } from './commands'
import { entSnap, richSnap, snap } from './testGraphs'

/**
 * validateAiBatch 校验阶段语义（issue #99 从 commands.test.ts 按场景拆分）：
 * 完整问题收集（纠错回喂的全量清单）、两阶段校验（阶段 A 全量形状 +
 * 阶段 B 首错即停）与恒非法容器判定；契约来源见各 describe 注释。
 */

describe('validateAiBatch：完整问题收集 · 逐条收集与级联抑制（评审 5138829847）', () => {
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
        {
          op: 'create_node',
          nodeType: 'beat',
          data: { label: '立足' },
          ref: 'b',
        },
        { op: 'connect_edge', sourceId: 'b', targetId: 'n1' },
      ],
      snap(),
    )
    expect(v.ok).toBe(false)
    expect(v.commands).toEqual([])
    // 只点名 create 自身的字段错误；修复后依赖命令自愈，不诱导模型改写
    expect(v.issues).toHaveLength(1)
    expect(v.issues[0]?.message).toContain('label')
    expect(v.issues.map((i) => i.message).join('\n')).not.toContain(
      '端点不存在',
    )
  })
})

describe('validateAiBatch：完整问题收集 · 分层延后与原子性', () => {
  it('前序形状失败时其后的真实缺失分层延后：修复重放后独立点名', () => {
    const v = validateAiBatch(
      [
        {
          op: 'create_node',
          nodeType: 'beat',
          data: { label: '立足' },
          ref: 'b',
        },
        { op: 'connect_edge', sourceId: 'zz', targetId: 'n1' },
      ],
      snap(),
    )
    // 阶段 B 首错即停：create 失败 → connect 本轮不校验（分层，契约变更）
    expect(v.issues).toHaveLength(1)
    expect(v.issues[0]?.message).toContain('label')

    const repaired = validateAiBatch(
      [
        {
          op: 'create_node',
          nodeType: 'beat',
          data: { name: '立足' },
          ref: 'b',
        },
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
        {
          op: 'create_node',
          nodeType: 'beat',
          data: { summary: '小店开张' },
          ref: 'b',
        },
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
describe('validateAiBatch：两阶段校验 · 阶段 A 全量形状点名', () => {
  it('阶段 A 全量收集形状错误：多命令一次点名，依赖命令不级联', () => {
    const v = validateAiBatch(
      [
        {
          op: 'create_node',
          nodeType: 'branch',
          ref: 'nb',
          data: { prompt: '？', options: 42 },
        },
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
        {
          op: 'create_node',
          nodeType: 'branch',
          ref: 'nb',
          data: { prompt: '？', options: 42 },
        },
        {
          op: 'connect_edge',
          sourceId: 'nb',
          targetId: 's1',
          edgeKind: 'weird',
        },
        {
          op: 'connect_edge',
          sourceId: 'nb',
          targetId: 's1',
          edgeKind: 'branch',
          optionIndex: -1,
        },
      ],
      richSnap(),
    )
    expect(v.issues.map((i) => i.index)).toEqual([0, 1, 2])
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
})

describe('validateAiBatch：两阶段校验 · 阶段 B 首错即停与分层延后', () => {
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
        {
          op: 'create_node',
          nodeType: 'branch',
          ref: 'nb',
          data: { prompt: '？', options: 42 },
        },
        { op: 'update_node', nodeId: 'nb', patch: { prompt: 5 } },
      ],
      richSnap(),
    )
    // prompt 属可写类型字段的并集：阶段 A 不按未知类型点名；类型专属的
    // 值形状错误随修复重放在阶段 B 点名（分层暴露，契约变更决策）
    expect(v.issues).toHaveLength(1)
    expect(v.issues[0]?.index).toBe(0)
  })
})

describe('validateAiBatch：两阶段校验 · 顺序语义与删除降级', () => {
  it('前序 delete + 同名 ref 重建换主：update 类型专属检查让位阶段 B（评审 5174231991）', () => {
    const snapWithX: AiGraphSnapshot = {
      nodes: [{ id: 'x', type: 'scene', label: '场 01' }],
      edges: [],
      assets: new Map(),
    }
    const v = validateAiBatch(
      [
        { op: 'delete_node', nodeId: 'x' },
        {
          op: 'create_node',
          nodeType: 'beat',
          ref: 'x',
          data: { name: '立足' },
        },
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

describe('validateAiBatch · 目标类型未知时的恒非法容器判定（issue 67）', () => {
  it('失败 create 未登记暂定类型：经 ref 的 update 携非数组唯一归属 array 字段同轮点名', () => {
    for (const key of ['options', 'lines', 'characterIds', 'refs']) {
      const v = validateAiBatch(
        [
          { op: 'create_node', nodeType: 'dragon', ref: 'nb' },
          { op: 'update_node', nodeId: 'nb', patch: { [key]: 'foo' } },
        ],
        snap(),
      )
      expect(v.ok, key).toBe(false)
      // create 的未知类型与 update 的容器形状同轮全量回喂，不再等下一轮
      expect(
        v.issues.map((i) => i.index),
        key,
      ).toEqual([0, 1])
      expect(v.issues[1]?.message, key).toContain(`${key} 须为数组`)
    }
  })

  it('唯一归属 array 字段为合法数组时不因目标未知误报', () => {
    const v = validateAiBatch(
      [
        { op: 'create_node', nodeType: 'dragon', ref: 'nb' },
        { op: 'update_node', nodeId: 'nb', patch: { options: ['A', 'B'] } },
      ],
      snap(),
    )
    expect(v.issues.map((i) => i.index)).toEqual([0])
  })

  it('多类型共有字段与非 array 字段仍分层延后（契约收窄仅限恒非法可判定域）', () => {
    const v = validateAiBatch(
      [
        { op: 'create_node', nodeType: 'dragon', ref: 'nb' },
        { op: 'update_node', nodeId: 'nb', patch: { prompt: 5, tone: 'x' } },
      ],
      snap(),
    )
    // prompt（branch/shot 共有）、tone（beat 唯一但非 array）：类型相关
    // 形状不属恒非法可判定域，维持阶段 B 分层延后（契约边界不变）
    expect(v.issues.map((i) => i.index)).toEqual([0])
  })

  it('删除 token 换主路径同样点名：恒非法判定与目标归属解耦', () => {
    const snapWithX: AiGraphSnapshot = {
      nodes: [{ id: 'x', type: 'scene', label: '场 01' }],
      edges: [],
      assets: new Map(),
    }
    const v = validateAiBatch(
      [
        { op: 'delete_node', nodeId: 'x' },
        {
          op: 'create_node',
          nodeType: 'beat',
          ref: 'x',
          data: { name: '立足' },
        },
        { op: 'update_node', nodeId: 'x', patch: { options: 'foo' } },
      ],
      snapWithX,
    )
    expect(v.ok).toBe(false)
    expect(
      v.issues.some(
        (i) => i.index === 2 && i.message.includes('options 须为数组'),
      ),
    ).toBe(true)
  })
})

// 节点 ref 别名冲突守卫（issue 117，镜像实体域 entityRefCollisionIssue 的
// 同一规则）：校验侧 resolveRef 以既有 id 优先、执行侧 refToId 以别名优先，
// 别名与在存节点 id（或折叠期虚拟 id 的保留前缀）相撞会让同一 token 在
// 预览校验与执行解析到不同节点——登记点整批拒绝，两侧必同解。
describe('validateAiBatch：阶段 B 折叠 · 节点 ref 别名与在存节点 id 冲突（issue 117）', () => {
  it('create 的 ref 与既有节点 id 同名时整批拒绝，消除错目标绑定', () => {
    // issue 117 复现批次：n2 是既有 beat；守卫缺失时校验按真 id 验
    // beat.tone、执行按别名把 tone 写进新建 dialogue
    const v = validateAiBatch(
      [
        {
          op: 'create_node',
          nodeType: 'dialogue',
          ref: 'n2',
          data: { name: '对质' },
        },
        { op: 'update_node', nodeId: 'n2', patch: { tone: '误写基调' } },
      ],
      snap(),
    )
    expect(v.ok).toBe(false)
    expect(v.commands).toEqual([])
    expect(v.issues).toHaveLength(1)
    expect(v.issues[0]?.index).toBe(0)
    expect(v.issues[0]?.message).toContain('ref 别名')
  })

  it('ref 与保留前缀 __new__: 同形时同样拒绝，后续虚拟 id 不得抢占别名', () => {
    // '__new__:1' 先被别名占用，第二 create 的虚拟 id 会与其同形——校验
    // 的 id 优先解析将命中该虚拟节点而执行仍按别名表，同属错目标绑定
    const v = validateAiBatch(
      [
        {
          op: 'create_node',
          nodeType: 'beat',
          ref: '__new__:1',
          data: { name: '立足' },
        },
        { op: 'create_node', nodeType: 'scene', data: { name: '场 02' } },
        { op: 'update_node', nodeId: '__new__:1', patch: { tone: '紧凑' } },
      ],
      snap(),
    )
    expect(v.ok).toBe(false)
    expect(v.issues).toHaveLength(1)
    expect(v.issues[0]?.index).toBe(0)
    expect(v.issues[0]?.message).toContain('ref 别名')
  })
})
