import { describe, expect, it } from 'vitest'
import { validateAiBatch, type AiGraphSnapshot } from './commands'
import { richSnap, snap } from './testGraphs'

/**
 * contingent 自愈机制的折叠校验用例（issue 39 的评审迭代域，issue 68
 * 拆分自 commands.test.ts）：失败前序（branch options 更新、连线变更、
 * create）的依赖命令按 contingent 跳过、随前序修复自愈；独立可判定的
 * 约束不被屏蔽、首轮进完整清单，暂定拓扑与残留边快照的覆盖语义在此
 * 锁定。主文件保留批次折叠、白名单与载荷形状等通用域。
 */

describe('contingent：依赖失败 branch options 更新的出口连线（评审 5139209906）', () => {
  it('该分支的越界 optionIndex 随前序修复自愈，不点名；仅报 options 异型', () => {
    const v = validateAiBatch(
      [
        { op: 'update_node', nodeId: 'b1', patch: { options: [{ id: 'ob-a', label: '追' }, { label: 5 }] } },
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 2 },
      ],
      richSnap(),
    )
    expect(v.ok).toBe(false)
    expect(v.commands).toEqual([])
    expect(v.issues).toHaveLength(1)
    expect(v.issues[0]?.message).toContain('异型')
    expect(v.issues.map((i) => i.message).join('\n')).not.toContain('optionIndex')
  })

  it('豁免只限失败更新的分支：其他分支的越界连线仍独立点名', () => {
    const s: AiGraphSnapshot = {
      nodes: [
        { id: 's1', type: 'scene', label: '场' },
        { id: 'b1', type: 'branch', label: '分支一', options: [{ id: 'o1', label: 'A' }] },
        { id: 'b2', type: 'branch', label: '分支二', options: [{ id: 'o2', label: 'B' }] },
      ],
      edges: [],
      assets: new Map(),
    }
    const v = validateAiBatch(
      [
        { op: 'update_node', nodeId: 'b1', patch: { options: ['A', { label: 5 }] } },
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 1 },
        { op: 'connect_edge', sourceId: 'b2', targetId: 's1', edgeKind: 'branch', optionIndex: 5 },
      ],
      s,
    )
    expect(v.ok).toBe(false)
    expect(v.issues).toHaveLength(2)
    expect(v.issues[0]?.index).toBe(0)
    expect(v.issues[0]?.message).toContain('异型')
    expect(v.issues[1]?.index).toBe(2)
    expect(v.issues[1]?.message).toContain('optionIndex')
  })
})

describe('contingent：依赖失败连线变更的后续连线（评审 5139616254）', () => {
  it('依赖失败断线的反向连线按 contingent 跳过，不误报成环', () => {
    // 既有 n2 → n1；模型想反转：断线写反（n1→n2 不存在）失败，反向连线
    // n1 → n2 在残留边上被误报成环——修复断线后本会合法
    const v = validateAiBatch(
      [
        { op: 'disconnect_edge', sourceId: 'n1', targetId: 'n2' },
        { op: 'connect_edge', sourceId: 'n1', targetId: 'n2' },
      ],
      snap(),
    )
    expect(v.ok).toBe(false)
    expect(v.commands).toEqual([])
    expect(v.issues).toHaveLength(1)
    expect(v.issues[0]?.message).toContain('没有这条连线')
    expect(v.issues.map((i) => i.message).join('\n')).not.toContain('会造成循环剧情')
  })

  it('依赖失败连线的断线按 contingent 跳过，不误报「没有这条连线」', () => {
    const v = validateAiBatch(
      [
        { op: 'connect_edge', sourceId: 'n1', targetId: 'n2' },
        { op: 'disconnect_edge', sourceId: 'n1', targetId: 'n2' },
      ],
      snap(),
    )
    expect(v.issues).toHaveLength(1)
    expect(v.issues[0]?.message).toContain('会造成循环剧情')
  })

  it('无失败断线依托的真实成环仍独立点名（不过度抑制）', () => {
    const v = validateAiBatch([{ op: 'connect_edge', sourceId: 'n1', targetId: 'n2' }], snap())
    expect(v.issues).toHaveLength(1)
    expect(v.issues[0]?.message).toContain('会造成循环剧情')
  })
})

describe('contingent 连线的独立约束仍进首轮清单（评审 5139865818）', () => {
  it('contingent 出口连线仍独立校验端点类型，与 options 异型并列收集', () => {
    const v = validateAiBatch(
      [
        { op: 'update_node', nodeId: 'b1', patch: { options: [{ id: 'ob-a', label: '追' }, { label: 5 }] } },
        { op: 'connect_edge', sourceId: 'b1', targetId: 'sh1', edgeKind: 'branch', optionIndex: 2 },
      ],
      richSnap(),
    )
    expect(v.ok).toBe(false)
    expect(v.commands).toEqual([])
    // options 异型 + 端点类型（分支连线不得指向分镜卡）均独立于选项表，
    // 首轮即进完整清单；仅 optionIndex 越界延后
    expect(v.issues).toHaveLength(2)
    expect(v.issues[0]?.message).toContain('异型')
    expect(v.issues[1]?.message).toContain('分镜卡不参与剧情流')
    expect(v.issues.map((i) => i.message).join('\n')).not.toContain('optionIndex')
  })
})

describe('失败标记的生命周期：成功覆盖 options 后清除（评审 5139995027）', () => {
  it('后续成功更新后，连线按最新选项表独立校验 optionIndex', () => {
    const v = validateAiBatch(
      [
        { op: 'update_node', nodeId: 'b1', patch: { options: [{ id: 'ob-a', label: '追' }, { label: 5 }] } },
        { op: 'update_node', nodeId: 'b1', patch: { options: ['只留一个'] } },
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 2 },
      ],
      richSnap(),
    )
    expect(v.ok).toBe(false)
    // 失败标记已被成功的 options 覆盖清除：越界按最新单选项表独立点名
    expect(v.issues).toHaveLength(2)
    expect(v.issues[0]?.index).toBe(0)
    expect(v.issues[0]?.message).toContain('异型')
    expect(v.issues[1]?.index).toBe(2)
    expect(v.issues[1]?.message).toContain('optionIndex')
  })
})

describe('contingent 不屏蔽独立可判定的约束（评审 5140147147）', () => {
  it('同一失败 ref 兼作两端的必然自环不被 contingent 屏蔽', () => {
    const v = validateAiBatch(
      [
        { op: 'create_node', nodeType: 'beat', data: { label: '立足' }, ref: 'b' },
        { op: 'connect_edge', sourceId: 'b', targetId: 'b' },
      ],
      snap(),
    )
    expect(v.issues).toHaveLength(2)
    expect(v.issues[0]?.message).toContain('label')
    expect(v.issues[1]?.message).toContain('会造成循环剧情')
  })

  it('options 合法但更新因无关标量失败：连线按暂定选项表独立校验', () => {
    const v = validateAiBatch(
      [
        { op: 'update_node', nodeId: 'b1', patch: { options: ['只留一个'], episodeNo: 0 } },
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 2 },
      ],
      richSnap(),
    )
    expect(v.issues).toHaveLength(2)
    expect(v.issues[0]?.message).toContain('episodeNo')
    expect(v.issues[1]?.index).toBe(1)
    expect(v.issues[1]?.message).toContain('optionIndex')
  })

  it('失败断线不豁免必然自环', () => {
    const v = validateAiBatch(
      [
        { op: 'disconnect_edge', sourceId: 'n1', targetId: 'n1' },
        { op: 'connect_edge', sourceId: 'n1', targetId: 'n1' },
      ],
      snap(),
    )
    expect(v.issues).toHaveLength(2)
    expect(v.issues[0]?.message).toContain('没有这条连线')
    expect(v.issues[1]?.message).toContain('会造成循环剧情')
  })
})

describe('暂定选项表级联与 contingent update 的独立形状（评审 5140344314）', () => {
  it('暂定 options 同步级联删边：依赖旧出口消失的反向连线不再误报成环', () => {
    const s: AiGraphSnapshot = {
      nodes: [
        { id: 's1', type: 'scene', label: '场' },
        { id: 'b1', type: 'branch', label: '分支', options: [{ id: 'o1', label: 'A' }, { id: 'o2', label: 'B' }] },
        { id: 'c1', type: 'beat', label: '节拍' },
      ],
      // o2 出口 B→C：options 更新修复后该出口被级联删除，C→B 随之合法
      edges: [{ source: 'b1', target: 'c1', sourceHandle: 'option-o2' }],
      assets: new Map(),
    }
    const v = validateAiBatch(
      [
        { op: 'update_node', nodeId: 'b1', patch: { options: ['保留首项'], episodeNo: 0 } },
        { op: 'connect_edge', sourceId: 'c1', targetId: 'b1', edgeKind: 'sequence' },
      ],
      s,
    )
    expect(v.ok).toBe(false)
    expect(v.issues).toHaveLength(1)
    expect(v.issues[0]?.message).toContain('episodeNo')
    expect(v.issues.map((i) => i.message).join('\n')).not.toContain('会造成循环剧情')
  })

  it('contingent ref 的 update 载荷自身错误仍独立点名', () => {
    const v = validateAiBatch(
      [
        { op: 'create_node', nodeType: 'beat', data: { label: '立足' }, ref: 'b' },
        { op: 'update_node', nodeId: 'b', patch: {} },
        { op: 'update_node', nodeId: 'b', patch: { not_any_field: 1, tone: '紧凑' } },
      ],
      snap(),
    )
    expect(v.issues).toHaveLength(3)
    expect(v.issues[0]?.message).toContain('label')
    expect(v.issues[1]?.message).toContain('patch 为空')
    expect(v.issues[2]?.message).toContain('not_any_field')
  })
})

describe('失败标记与残留边快照的覆盖语义（评审 5140501690）', () => {
  it('暂定选项表覆盖旧失败标记：越界 optionIndex 仍进首轮清单', () => {
    const v = validateAiBatch(
      [
        { op: 'update_node', nodeId: 'b1', patch: { options: [{ id: 'ob-a', label: '追' }, { label: 5 }] } },
        { op: 'update_node', nodeId: 'b1', patch: { options: ['只留一个'], episodeNo: 0 } },
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 2 },
      ],
      richSnap(),
    )
    expect(v.ok).toBe(false)
    // 第二次更新虽因 episodeNo 失败，但 options 结果已可判定（暂定表生效）
    // 并清除第一次异型失败留下的 contingent 标记：越界按单选项表独立点名
    expect(v.issues).toHaveLength(3)
    expect(v.issues[0]?.message).toContain('异型')
    expect(v.issues[1]?.message).toContain('episodeNo')
    expect(v.issues[2]?.index).toBe(2)
    expect(v.issues[2]?.message).toContain('optionIndex')
  })

  it('失败断线后新增的反向边造成的环仍独立点名', () => {
    const s: AiGraphSnapshot = {
      nodes: [
        { id: 'a', type: 'beat', label: '节拍 A' },
        { id: 'b', type: 'beat', label: '节拍 B' },
      ],
      edges: [],
      assets: new Map(),
    }
    const v = validateAiBatch(
      [
        { op: 'disconnect_edge', sourceId: 'a', targetId: 'b' },
        { op: 'connect_edge', sourceId: 'b', targetId: 'a' },
        { op: 'connect_edge', sourceId: 'a', targetId: 'b' },
      ],
      s,
    )
    // 空图上的失败断线无可修正的残留边：b → a 由本批中间命令新增，
    // 修正/删除首条断线都不会移除它，第三条环错误独立进首轮清单
    expect(v.issues).toHaveLength(2)
    expect(v.issues[0]?.message).toContain('没有这条连线')
    expect(v.issues[1]?.index).toBe(2)
    expect(v.issues[1]?.message).toContain('会造成循环剧情')
  })

  it('残留同对边之外仍成环时独立点名（快照边移除后环仍在）', () => {
    const s: AiGraphSnapshot = {
      nodes: [
        { id: 'a', type: 'beat', label: '节拍 A' },
        { id: 'b', type: 'beat', label: '节拍 B' },
        { id: 'c', type: 'beat', label: '节拍 C' },
      ],
      // b → a 是失败断线的同对残留边；b → c → a 是与之无关的既有路径
      edges: [
        { source: 'b', target: 'a' },
        { source: 'b', target: 'c' },
        { source: 'c', target: 'a' },
      ],
      assets: new Map(),
    }
    const v = validateAiBatch(
      [
        { op: 'disconnect_edge', sourceId: 'a', targetId: 'b' },
        { op: 'connect_edge', sourceId: 'a', targetId: 'b' },
      ],
      s,
    )
    expect(v.issues).toHaveLength(2)
    expect(v.issues[0]?.message).toContain('没有这条连线')
    expect(v.issues[1]?.message).toContain('会造成循环剧情')
  })
})

describe('失败 create 的暂定类型参与后续校验（评审 5143607106）', () => {
  it('已声明类型对 contingent update 的字段白名单独立点名', () => {
    const v = validateAiBatch(
      [
        { op: 'create_node', nodeType: 'beat', data: { label: '立足' }, ref: 'b' },
        { op: 'update_node', nodeId: 'b', patch: { prompt: '追或不追？' } },
      ],
      snap(),
    )
    // create 的 nodeType 已独立通过校验：修正 data 不改变节奏卡语义，
    // prompt 即使 create 修复后仍非法，首轮即按暂定类型点名
    expect(v.issues).toHaveLength(2)
    expect(v.issues[0]?.message).toContain('label')
    expect(v.issues[1]?.message).toContain('prompt')
    expect(v.issues[1]?.message).toContain('节奏卡')
  })

  it('已声明类型的值形状错误同样进首轮清单', () => {
    const v = validateAiBatch(
      [
        { op: 'create_node', nodeType: 'scene', data: { name: 5 }, ref: 's' },
        { op: 'update_node', nodeId: 's', patch: { episodeNo: 0 } },
      ],
      snap(),
    )
    expect(v.issues).toHaveLength(2)
    expect(v.issues[0]?.message).toContain('name')
    expect(v.issues[1]?.message).toContain('episodeNo')
  })

  it('暂定 branch 类型的 options 成员异型同样点名', () => {
    const v = validateAiBatch(
      [
        { op: 'create_node', nodeType: 'branch', data: { prompt: 5 }, ref: 'b' },
        { op: 'update_node', nodeId: 'b', patch: { options: [null] } },
      ],
      snap(),
    )
    expect(v.issues).toHaveLength(2)
    expect(v.issues[0]?.message).toContain('prompt')
    expect(v.issues[1]?.message).toContain('异型')
  })
})

describe('contingent 出口连线入暂定拓扑（评审 5143607106）', () => {
  it('端点已确定的 contingent 出口边参与后续成环判定', () => {
    const v = validateAiBatch(
      [
        { op: 'update_node', nodeId: 'b1', patch: { options: [{ label: 5 }] } },
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 0 },
        { op: 'connect_edge', sourceId: 's1', targetId: 'b1' },
      ],
      richSnap(),
    )
    // options 修复后 b1 → s1 生效，反向边 s1 → b1 仍必然成环：后续连线
    // 按含暂定边的拓扑独立判定，不因本轮省略而漏报
    expect(v.issues).toHaveLength(2)
    expect(v.issues[0]?.message).toContain('异型')
    expect(v.issues[1]?.index).toBe(2)
    expect(v.issues[1]?.message).toContain('会造成循环剧情')
  })
})

describe('暂定出口边随选项表变化重算（评审 5143770306）', () => {
  it('后续 options 覆盖清空选项后，暂定出口边失效，反向连线不再误报成环', () => {
    const v = validateAiBatch(
      [
        { op: 'update_node', nodeId: 'b1', patch: { options: [{ label: 5 }] } },
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 0 },
        { op: 'update_node', nodeId: 'b1', patch: { options: [] } },
        { op: 'connect_edge', sourceId: 's1', targetId: 'b1' },
      ],
      richSnap(),
    )
    // 空数组覆盖级联删除全部出口：暂定边随选项表失效，s1 → b1 实际合法
    expect(v.issues).toHaveLength(1)
    expect(v.issues[0]?.message).toContain('异型')
  })

  it('后续覆盖仍保留该选项位时，暂定出口边继续参与成环判定', () => {
    const v = validateAiBatch(
      [
        { op: 'update_node', nodeId: 'b1', patch: { options: [{ label: 5 }] } },
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 0 },
        { op: 'update_node', nodeId: 'b1', patch: { options: ['保留首项'] } },
        { op: 'connect_edge', sourceId: 's1', targetId: 'b1' },
      ],
      richSnap(),
    )
    expect(v.issues).toHaveLength(2)
    expect(v.issues[0]?.message).toContain('异型')
    expect(v.issues[1]?.message).toContain('会造成循环剧情')
  })
})

describe('暂定出口边的稳定身份与断线可见性（评审 5143929155）', () => {
  it('同长度但换新显式选项 id 的覆盖使暂定出口边失效', () => {
    const v = validateAiBatch(
      [
        { op: 'update_node', nodeId: 'b1', patch: { options: [{ label: 5 }] } },
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 0 },
        { op: 'update_node', nodeId: 'b1', patch: { options: [{ id: 'opt-new', label: '换' }] } },
        { op: 'connect_edge', sourceId: 's1', targetId: 'b1' },
      ],
      richSnap(),
    )
    // 显式新 id 覆盖后旧选项被级联替换：暂定边随稳定 id 消失，反向连线合法
    expect(v.issues).toHaveLength(1)
    expect(v.issues[0]?.message).toContain('异型')
  })

  it('断线命中前序暂定出口边时不误报「没有这条连线」', () => {
    const v = validateAiBatch(
      [
        { op: 'update_node', nodeId: 'b1', patch: { options: [{ label: 5 }] } },
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 0 },
        { op: 'disconnect_edge', sourceId: 'b1', targetId: 's1' },
      ],
      richSnap(),
    )
    expect(v.issues).toHaveLength(1)
    expect(v.issues[0]?.message).toContain('异型')
  })

  it('暂定出口边被断线移除后，反向连线不再误报成环', () => {
    const v = validateAiBatch(
      [
        { op: 'update_node', nodeId: 'b1', patch: { options: [{ label: 5 }] } },
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 0 },
        { op: 'disconnect_edge', sourceId: 'b1', targetId: 's1' },
        { op: 'connect_edge', sourceId: 's1', targetId: 'b1' },
      ],
      richSnap(),
    )
    expect(v.issues).toHaveLength(1)
    expect(v.issues[0]?.message).toContain('异型')
  })
})

// issue 46 的 contingent 维度（评审 5163320408）：contingent 只豁免依赖
// 修复后选项表的检查（上界与句柄解析）——内在非法的 optionIndex（缺省/
// 非数值/负数/非整数）不随任何修复生效，首轮即点名，完整清单不缺项。
describe('contingent 出口连线的内在非法 optionIndex 仍独立点名（评审 5163320408）', () => {
  it('非数组 options 失败更新后，缺省/负数/小数/字符串下标独立点名', () => {
    for (const optionIndex of [{}, -1, 1.5, '0']) {
      const v = validateAiBatch(
        [
          { op: 'update_node', nodeId: 'b1', patch: { options: 'foo' } },
          { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex },
        ],
        richSnap(),
      )
      expect(v.ok).toBe(false)
      expect(v.issues.some((i) => i.index === 1 && i.message.includes('optionIndex'))).toBe(true)
    }
    const missing = validateAiBatch(
      [
        { op: 'update_node', nodeId: 'b1', patch: { options: 'foo' } },
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch' },
      ],
      richSnap(),
    )
    expect(missing.issues.some((i) => i.index === 1 && i.message.includes('optionIndex'))).toBe(true)
  })

  it('成员异型路径同口径点名；类型合法但越界的下标维持 contingent 跳过', () => {
    const flagged = validateAiBatch(
      [
        { op: 'update_node', nodeId: 'b1', patch: { options: [{ label: 5 }] } },
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: -1 },
      ],
      richSnap(),
    )
    expect(flagged.issues.some((i) => i.index === 1 && i.message.includes('optionIndex'))).toBe(true)
    // 对照：类型合法的越界下标依赖修复后的表长，维持自愈语义不点名
    const deferred = validateAiBatch(
      [
        { op: 'update_node', nodeId: 'b1', patch: { options: 'foo' } },
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 2 },
      ],
      richSnap(),
    )
    expect(deferred.issues.map((i) => i.message).join('\n')).not.toContain('optionIndex')
  })
})

// contingent 出口连线的同键重复判定（评审 5163489093）：失败 options
// 更新后，同端点同原始下标的两条连线无论修复后选项表如何都必然同端口，
// 首轮即点名重复，不让成对重复各占暂定登记、多耗纠错轮次；断线撤销
// 登记后同键重新合法（与撤销前断线的非 contingent 语义一致）。
describe('contingent 出口连线的同键重复判定（评审 5163489093）', () => {
  it('失败 options 更新后，两条同端点同下标的连线首轮点名重复', () => {
    const v = validateAiBatch(
      [
        { op: 'update_node', nodeId: 'b1', patch: { options: 'foo' } },
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 0 },
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 0 },
      ],
      richSnap(),
    )
    expect(v.ok).toBe(false)
    expect(v.commands).toEqual([])
    expect(v.issues).toHaveLength(2)
    expect(v.issues[0]?.index).toBe(0)
    expect(v.issues[0]?.message).toContain('options')
    // 拒绝语义按命令定位断言（评审 5163320408 处置：诊断措辞不作契约）
    expect(v.issues[1]?.index).toBe(2)
  })

  it('下标越出当前表长的同键重复同样点名（暂定边未登记仍比对原始键）', () => {
    const v = validateAiBatch(
      [
        { op: 'update_node', nodeId: 'b1', patch: { options: 'foo' } },
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 2 },
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 2 },
      ],
      richSnap(),
    )
    expect(v.issues).toHaveLength(2)
    expect(v.issues[1]?.index).toBe(2)
  })

  it('断线撤销登记后，同端点同下标的后续 contingent 连线重新合法', () => {
    const v = validateAiBatch(
      [
        { op: 'update_node', nodeId: 'b1', patch: { options: 'foo' } },
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 0 },
        { op: 'disconnect_edge', sourceId: 'b1', targetId: 's1' },
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 0 },
      ],
      richSnap(),
    )
    expect(v.issues).toHaveLength(1)
    expect(v.issues[0]?.message).toContain('options')
  })

  it('不同下标的 contingent 连线不误报重复', () => {
    const v = validateAiBatch(
      [
        { op: 'update_node', nodeId: 'b1', patch: { options: 'foo' } },
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 0 },
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 1 },
      ],
      richSnap(),
    )
    expect(v.issues).toHaveLength(1)
    expect(v.issues[0]?.message).toContain('options')
  })

  // 评审 5163729170：键绑定登记时解析的稳定选项 id——成功覆盖移除该选项
  // 后，同下标重连解析到的是新选项，不与旧键匹配，不误报重复。
  it('成功覆盖移除原选项后，同下标 contingent 重连不误报重复', () => {
    const v = validateAiBatch(
      [
        { op: 'update_node', nodeId: 'b1', patch: { options: 'foo' } },
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 0 },
        { op: 'update_node', nodeId: 'b1', patch: { options: [{ id: 'opt-new', label: '换' }] } },
        { op: 'update_node', nodeId: 'b1', patch: { options: 'bar' } },
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 0 },
      ],
      richSnap(),
    )
    // 首尾两条 update 各报一个 options 错误；idx0 重连指向新选项 opt-new，
    // 未被点名（拒绝语义按命令定位断言，评审 5163320408 处置）
    expect(v.issues).toHaveLength(2)
    expect(v.issues.every((i) => i.message.includes('options'))).toBe(true)
    expect(v.issues.every((i) => i.index !== 4)).toBe(true)
  })

  it('成功覆盖按位置改名保留原选项 id 时，同键重连仍判重复（对照）', () => {
    const v = validateAiBatch(
      [
        { op: 'update_node', nodeId: 'b1', patch: { options: 'foo' } },
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 0 },
        { op: 'update_node', nodeId: 'b1', patch: { options: ['追（改名）'] } },
        { op: 'update_node', nodeId: 'b1', patch: { options: 'bar' } },
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 0 },
      ],
      richSnap(),
    )
    // 字符串更新按位置对位保留 ob-a：两条连线同端口，重复是真阳性
    expect(v.issues.some((i) => i.index === 4)).toBe(true)
  })
})

// contingent 越界出口边的投影与判重键域（评审 5164170010）：越界下标的
// contingent 连线同样登记暂定投影——后续同端点断线按 contingent 跳过、
// 反向连线参与成环判定；判重键的 id 域与越界回退域分域编码，选项 id
// 字面量再巧也不与回退键相撞。
describe('contingent 越界出口边的投影与键域（评审 5164170010）', () => {
  it('越界下标的 contingent 连线投影参与断线与成环判定', () => {
    const disconnect = validateAiBatch(
      [
        { op: 'update_node', nodeId: 'b1', patch: { options: 'foo' } },
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 2 },
        { op: 'disconnect_edge', sourceId: 'b1', targetId: 's1' },
      ],
      richSnap(),
    )
    // 断线命中等价的暂定出口边，随前序修复自愈，不误报「没有这条连线」
    expect(disconnect.issues).toHaveLength(1)
    expect(disconnect.issues[0]?.message).toContain('options')

    const cycle = validateAiBatch(
      [
        { op: 'update_node', nodeId: 'b1', patch: { options: 'foo' } },
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 2 },
        { op: 'connect_edge', sourceId: 's1', targetId: 'b1' },
      ],
      richSnap(),
    )
    // 投影按「该连线生效」参与成环判定：反向连线独立点名，不漏报
    expect(cycle.issues).toHaveLength(2)
    expect(cycle.issues.some((i) => i.index === 2)).toBe(true)
  })

  it('成功覆盖落定新表后，越界投影按下标重解析；断线随投影生效判定', () => {
    const v = validateAiBatch(
      [
        { op: 'update_node', nodeId: 'b1', patch: { options: 'foo' } },
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 2 },
        { op: 'update_node', nodeId: 'b1', patch: { options: ['甲', '乙', '丙'] } },
        { op: 'update_node', nodeId: 'b1', patch: { options: 'bar' } },
        { op: 'disconnect_edge', sourceId: 'b1', targetId: 's1' },
      ],
      richSnap(),
    )
    // idx2 落进新表：投影转为绑定新选项；其后断线命中投影，contingent 跳过
    expect(v.issues).toHaveLength(2)
    expect(v.issues.every((i) => i.message.includes('options'))).toBe(true)
  })

  it('选项 id 字面量与越界回退键分域编码，不互撞', () => {
    const s: AiGraphSnapshot = {
      nodes: [
        { id: 's1', type: 'scene', label: '场' },
        { id: 'b1', type: 'branch', label: '分支', options: [{ id: '#2', label: 'A' }] },
      ],
      edges: [],
      assets: new Map(),
    }
    const v = validateAiBatch(
      [
        { op: 'update_node', nodeId: 'b1', patch: { options: 'foo' } },
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 0 },
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 2 },
      ],
      s,
    )
    // 两条连线分别指向选项 #2 与修复后表的下标 2，端口不同，非重复
    expect(v.issues).toHaveLength(1)
    expect(v.issues[0]?.message).toContain('options')
  })
})

// contingent 键与投影随选项移除级联退役（评审 5164450788）：成功或投影的
// options 覆盖移除已绑定选项时，已解析投影与其 id 判重键一并永久移除
// （§8.2.2 的级联删边语义）——同 id 其后被重新引入时旧边不复活（不参与
// 成环判定），同端点同下标重连不与已退役键相撞、不误判重复。
describe('contingent 键与投影随选项移除级联退役（评审 5164450788）', () => {
  it('选项移除后又重新引入同 id，同端点重连不误报重复', () => {
    const v = validateAiBatch(
      [
        { op: 'update_node', nodeId: 'b1', patch: { options: 'foo' } },
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 0 },
        { op: 'update_node', nodeId: 'b1', patch: { options: [{ id: 'opt-new', label: '换' }] } },
        { op: 'update_node', nodeId: 'b1', patch: { options: [{ id: 'ob-a', label: '回归' }] } },
        { op: 'update_node', nodeId: 'b1', patch: { options: 'bar' } },
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 0 },
      ],
      richSnap(),
    )
    // 两条非数组 update 各报一个 options 错误；重连指向重新引入的 ob-a，
    // 旧键已随移除退役，不被点名（拒绝语义按命令定位断言）
    expect(v.issues).toHaveLength(2)
    expect(v.issues.every((i) => i.message.includes('options'))).toBe(true)
    expect(v.issues.every((i) => i.index !== 5)).toBe(true)
  })

  it('选项移除后旧投影不再参与成环判定，同 id 重新引入也不复活', () => {
    const v = validateAiBatch(
      [
        { op: 'update_node', nodeId: 'b1', patch: { options: 'foo' } },
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 0 },
        { op: 'update_node', nodeId: 'b1', patch: { options: [{ id: 'opt-new', label: '换' }] } },
        { op: 'update_node', nodeId: 'b1', patch: { options: [{ id: 'ob-a', label: '回归' }] } },
        { op: 'connect_edge', sourceId: 's1', targetId: 'b1' },
      ],
      richSnap(),
    )
    // 旧投影已随选项移除退役：反向剧情流连线不构成环（本批尚无重连）
    expect(v.issues).toHaveLength(1)
    expect(v.issues[0]?.message).toContain('options')
  })

  it('投影更新（合法选项数组携未知字段失败）同样级联退役', () => {
    const v = validateAiBatch(
      [
        { op: 'update_node', nodeId: 'b1', patch: { options: 'foo' } },
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 0 },
        { op: 'update_node', nodeId: 'b1', patch: { options: [{ id: 'opt-new', label: '换' }], nope: 1 } },
        { op: 'update_node', nodeId: 'b1', patch: { options: [{ id: 'ob-a', label: '回归' }], nope: 1 } },
        { op: 'update_node', nodeId: 'b1', patch: { options: 'bar' } },
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 0 },
      ],
      richSnap(),
    )
    // 未知字段的两条 update 各报一个白名单错误 + 两条非数组 options 错误；
    // 投影移除同样退役旧键，重连不被点名
    expect(v.issues).toHaveLength(4)
    expect(v.issues.every((i) => i.index !== 5)).toBe(true)
  })
})

// 暂定投影的判重与端点断线（评审 5164943585）：越界投影被合法更新落定为
// 已解析投影后，其端口已确定——同端点同选项的后续连线无论投影何时折入
// 虚拟图都必然同端口，首轮点名重复；端点级断线按执行通道语义移除全部
// 同端点投影，残留投影不得使反向连线误报成环。
describe('暂定投影的判重与端点断线（评审 5164943585）', () => {
  it('越界投影被合法更新落定后，同端口重连首轮点名重复', () => {
    const v = validateAiBatch(
      [
        { op: 'update_node', nodeId: 'b1', patch: { options: 'foo' } },
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 2 },
        { op: 'update_node', nodeId: 'b1', patch: { options: ['甲', '乙', '丙'] } },
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 2 },
      ],
      richSnap(),
    )
    // 首条 update 报 options 错误；idx2 投影随落定转为绑定丙，重连同端口
    // 必然重复，首轮点名（拒绝语义按命令定位断言）
    expect(v.issues).toHaveLength(2)
    expect(v.issues[0]?.message).toContain('options')
    expect(v.issues[1]?.index).toBe(3)
  })

  it('端点断线移除全部暂定投影，反向连线不因残留投影误报成环', () => {
    const v = validateAiBatch(
      [
        { op: 'update_node', nodeId: 'b1', patch: { options: 'foo' } },
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 2 },
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 3 },
        { op: 'disconnect_edge', sourceId: 'b1', targetId: 's1' },
        { op: 'connect_edge', sourceId: 's1', targetId: 'b1' },
      ],
      richSnap(),
    )
    // 断线按端点对移除全部投影（raw:2 与 raw:3）：反向剧情流连线不成环，
    // 仅报首条 options 错误
    expect(v.issues).toHaveLength(1)
    expect(v.issues[0]?.message).toContain('options')
  })

  it('端点断线连带清除同对虚拟边与暂定投影的并存登记', () => {
    const v = validateAiBatch(
      [
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 0 },
        { op: 'update_node', nodeId: 'b1', patch: { options: 'foo' } },
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 1 },
        { op: 'disconnect_edge', sourceId: 'b1', targetId: 's1' },
        { op: 'connect_edge', sourceId: 's1', targetId: 'b1' },
      ],
      richSnap(),
    )
    // 虚拟边与暂定投影同对并存：断线折叠为真实命令并一并清除两者，
    // 反向连线不成环，仅报 options 错误
    expect(v.issues).toHaveLength(1)
    expect(v.issues[0]?.message).toContain('options')
  })
})
