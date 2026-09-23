import { describe, expect, it } from 'vitest'
import type { Edge } from '@xyflow/react'
import { GRAPH_DIGEST_MAX_CHARS } from './graphDigest'
import { findNodesText } from './nodeSearch'
import type { CanvasNode } from '../nodes/types'

/** 构造最小节点（只带被测字段）。 */
function node(partial: Record<string, unknown>): CanvasNode {
  return partial as unknown as CanvasNode
}

function fixture(): { nodes: CanvasNode[]; edges: Edge[] } {
  const nodes: CanvasNode[] = [
    node({
      id: 's1',
      type: 'scene',
      position: { x: 0, y: 0 },
      data: {
        name: '天台追凶',
        sceneNo: 1,
        interior: true,
        synopsis: '',
        characterIds: [],
        time: '',
      },
    }),
    node({
      id: 'br1',
      type: 'branch',
      position: { x: 0, y: 0 },
      data: {
        prompt: '追或不追',
        options: [
          { id: 'o1', label: '追凶' },
          { id: 'o2', label: '放弃' },
        ],
      },
    }),
    node({
      id: 'd1',
      type: 'dialogue',
      position: { x: 0, y: 0 },
      data: { name: '摊牌', lines: [] },
    }),
  ]
  const edges: Edge[] = [
    { id: 'e1', source: 's1', target: 'br1', className: 'pw-edge-sequence' },
    {
      id: 'e2',
      source: 'br1',
      target: 'd1',
      type: 'branch',
      sourceHandle: 'option-o1',
      data: { optionLabel: '追凶' },
    },
  ]
  return { nodes, edges }
}

describe('findNodesText（issue #275 评审：被节选条目的可发现读取路径）', () => {
  it('按名称/文案跨类型检索，大小写不敏感', () => {
    const { nodes, edges } = fixture()
    const text = findNodesText(nodes, edges, '追凶')
    expect(text).toContain('- s1 场01·天台追凶')
    expect(text).toContain('- br1 分支·追或不追')
    expect(text).not.toContain('- d1')
  })

  it('匹配节点携带其全部关联边（含作为目标端），被摘要节选隐藏的连线可发现', () => {
    const { nodes, edges } = fixture()
    const text = findNodesText(nodes, edges, 'br1')
    expect(text).toContain('sequence: s1 → br1')
    expect(text).toContain('branch(选项追凶): br1 → d1')
  })

  it('多命中按 offset 翻页：页大小上限 + 计数标记带下一页偏移（issue #275 评审）', () => {
    const nodes: CanvasNode[] = Array.from({ length: 30 }, (_, i) =>
      node({
        id: `n${i + 1}`,
        type: 'beat',
        position: { x: 0, y: 0 },
        data: { name: `同名词${i + 1}`, tone: 'x' },
      }),
    )
    const edges: Edge[] = Array.from({ length: 20 }, (_, i) => ({
      id: `e${i}`,
      source: 'n1',
      target: `n${i + 2}`,
      className: 'pw-edge-sequence',
    }))
    const page1 = findNodesText(nodes, edges, '同名词')
    expect(page1).toMatch(/另有 6 个匹配未列出/)
    expect(page1).toContain('offset=24')
    expect(page1).toMatch(/另有 8 条连线未列出/)
    expect(page1).toContain('单查该节点 id')
    const page2 = findNodesText(nodes, edges, '同名词', 24)
    expect(page2).toContain('- n25')
    expect(page2).toContain('- n30')
  })

  it('单节点命中（按 id）时连线分页枚举：页 64 条 + 偏移续读（issue #275 评审）', () => {
    const hub: CanvasNode = node({
      id: 'hub',
      type: 'branch',
      position: { x: 0, y: 0 },
      data: {
        prompt: '枢纽',
        options: Array.from({ length: 70 }, (_, i) => ({
          id: `o${i + 1}`,
          label: `出口${i + 1}`,
        })),
      },
    })
    const targets: CanvasNode[] = Array.from({ length: 70 }, (_, i) =>
      node({
        id: `t${i + 1}`,
        type: 'beat',
        position: { x: 0, y: 0 },
        data: { name: `目的地${i + 1}`, tone: 'x' },
      }),
    )
    const edges: Edge[] = Array.from({ length: 70 }, (_, i) => ({
      id: `e${i + 1}`,
      source: 'hub',
      target: `t${i + 1}`,
      type: 'branch',
      sourceHandle: `option-o${i + 1}`,
    }))
    const page1 = findNodesText([hub, ...targets], edges, 'hub')
    expect(page1).toContain('branch(选项出口1): hub → t1')
    expect(page1).toContain('→ t64')
    expect(page1).not.toContain('→ t65')
    expect(page1).toMatch(/另有 6 条连线未列出/)
    expect(page1).toContain('offset=64')
    const cursor = page1.match(/cursor="([0-9a-f]+)"/)?.[1]
    expect(cursor).toBeTruthy()
    const page2 = findNodesText([hub, ...targets], edges, 'hub', 64, cursor)
    expect(page2).toContain('→ t65')
    expect(page2).toContain('→ t70')
    expect(page2).not.toMatch(/另有 \d+ 条连线未列出/)
  })

  it('删除前页连线后旧位置续页必须明确失效，不能漏掉原第 65 条（PR #294 评审）', () => {
    const hub = node({
      id: 'hub',
      type: 'beat',
      data: { name: '枢纽', tone: 'x' },
    })
    const edges: Edge[] = Array.from({ length: 70 }, (_, i) => ({
      id: `e${i}`,
      source: 'hub',
      target: `t${i}`,
    }))
    expect(findNodesText([hub], edges, 'hub')).toContain('offset=64')

    const stale = findNodesText([hub], edges.slice(1), 'hub', 64)
    expect(stale).toContain('重新枚举')
    expect(stale).not.toContain('→ t65')
    expect(findNodesText([hub], edges.slice(1), 'hub')).toContain('→ t64')
  })

  it('连线续页游标只在原连线顺序下继续，增删或重排后要求重新枚举（PR #294 评审）', () => {
    const hub = node({
      id: 'hub',
      type: 'beat',
      data: { name: '枢纽', tone: 'x' },
    })
    const edges: Edge[] = Array.from({ length: 70 }, (_, i) => ({
      id: `e${i}`,
      source: 'hub',
      target: `t${i}`,
    }))
    const first = findNodesText([hub], edges, 'hub')
    const next = first.match(
      /find_nodes\("hub", offset=(\d+), cursor="([0-9a-f]+)"\)/,
    )
    expect(next).toBeTruthy()
    const offset = Number(next![1]!)
    const cursor = next![2]!

    const unchanged = findNodesText([hub], edges, 'hub', offset, cursor)
    expect(unchanged).toContain('→ t64')
    expect(unchanged).not.toContain('→ t63')

    const added: Edge = { id: 'added', source: 'hub', target: 'new-target' }
    for (const changed of [
      edges.slice(1),
      [added, ...edges],
      [edges[1]!, edges[0]!, ...edges.slice(2)],
    ]) {
      const stale = findNodesText([hub], changed, 'hub', offset, cursor)
      expect(stale).toContain('重新枚举')
      expect(stale).not.toContain('→ t64')
    }
  })

  it('行级截断：单命中 6.5 万字符名称不原样携带（issue #275 评审）', () => {
    const giant: CanvasNode = node({
      id: 'g1',
      type: 'scene',
      position: { x: 0, y: 0 },
      data: {
        name: '巨'.repeat(65_536),
        sceneNo: 1,
        interior: true,
        synopsis: '',
        characterIds: [],
        time: '',
      },
    })
    const text = findNodesText([giant], [], 'g1')
    expect(text.length).toBeLessThan(1000)
    expect(text).not.toContain('巨'.repeat(400))
    expect(text).toContain('…')
  })

  it('多命中拼接超预算时按字符硬上限截断并声明未发送量（issue #275 评审）', () => {
    const label = '长'.repeat(170)
    const nodes: CanvasNode[] = Array.from({ length: 24 }, (_, i) =>
      node({
        id: `b${i + 1}`,
        type: 'branch',
        position: { x: 0, y: 0 },
        data: {
          prompt: `枢纽${i + 1}`,
          options: Array.from({ length: 13 }, (_, j) => ({
            id: `o${j + 1}`,
            label: `${label}${j}`,
          })),
        },
      }),
    )
    const edges: Edge[] = nodes.flatMap((n) =>
      Array.from({ length: 13 }, (_, j) => ({
        id: `${n.id}-e${j}`,
        source: n.id,
        target: `t-${n.id}-${j}`,
        type: 'branch',
        sourceHandle: `option-o${j + 1}`,
      })),
    )
    const page1 = findNodesText(nodes, edges, '枢纽')
    expect(page1.length).toBeLessThanOrEqual(GRAPH_DIGEST_MAX_CHARS)
    // 预算在整节点边界停止（不任意截断），游标 = 实际已列数
    expect(page1).toContain('已达字符预算')
    const cursor = Number(page1.match(/offset=(\d+)/)?.[1])
    expect(Number.isInteger(cursor)).toBe(true)
    expect(cursor).toBeGreaterThan(0)
    expect(cursor).toBeLessThan(24)
    // 续读页含第一页未出现的节点——offset=0 不再重复同一前缀
    const page2 = findNodesText(nodes, edges, '枢纽', cursor)
    const page1Node = page1.match(/- b(\d+) /)?.[1]
    const page2Nodes = [...page2.matchAll(/- b(\d+) /g)].map((m) => m[1])
    expect(page2Nodes.length).toBeGreaterThan(0)
    for (const n of page2Nodes) {
      expect(n).not.toBe(page1Node)
    }
  })

  it('选项文案超长时只裁剪文案：连线端点不被截断（PR #294 评审）', () => {
    const hub: CanvasNode = node({
      id: 'hub',
      type: 'branch',
      position: { x: 0, y: 0 },
      data: {
        prompt: '枢纽',
        options: [
          { id: 'o1', label: '长'.repeat(300) },
          { id: 'o2', label: '出口二' },
        ],
      },
    })
    const edges: Edge[] = [
      {
        id: 'e1',
        source: 'hub',
        target: 'far-target-1',
        type: 'branch',
        sourceHandle: 'option-o1',
      },
    ]
    const text = findNodesText([hub], edges, 'hub')
    // 端点是不可裁剪部分：完整 source → target 必须在场（get_node 不返回连线）
    expect(text).toContain(': hub → far-target-1')
    // 文案按预算裁剪并以省略号声明
    expect(text).toContain('选项长')
    const line = text.split('\n').find((l) => l.includes('far-target-1'))!
    expect(line.length).toBeLessThanOrEqual(200)
    expect(line).toContain('…')
  })

  it('查询回显与节点 id 计入总量预算：超长 id 不击穿预算并声明缩写（PR #294 评审）', () => {
    const giantId = 'i'.repeat(30_000)
    const giant: CanvasNode = node({
      id: giantId,
      type: 'beat',
      position: { x: 0, y: 0 },
      data: { name: '超长 id 节点', tone: 'x' },
    })
    // 零条连线：页头回显与节点身份自身不得突破预算
    const text = findNodesText([giant], [], giantId)
    expect(text.length).toBeLessThanOrEqual(GRAPH_DIGEST_MAX_CHARS)
    expect(text).toContain('已缩写')
    // 模糊路径同样有界：以同量级长文案检索不得原样回显
    const fuzzy = findNodesText([giant], [], '长'.repeat(30_000))
    expect(fuzzy.length).toBeLessThanOrEqual(GRAPH_DIGEST_MAX_CHARS)
  })

  it('id:<前缀> 分段返回完整 id：按名称发现的超长 id 节点可无损恢复（PR #294 评审）', () => {
    const giantId = 'i'.repeat(30_000)
    const byName: CanvasNode = node({
      id: giantId,
      type: 'beat',
      position: { x: 0, y: 0 },
      data: { name: '按名称找', tone: 'x' },
    })
    // 按名称发现（完整 id 从未出现在任何上下文）
    const found = findNodesText([byName], [], '按名称找')
    expect(found).toContain('id 已缩写')
    const handle = found.match(/find_nodes\("(id:[^"]+)", offset=1\)/)?.[1]
    expect(handle).toMatch(/id:i{80}#1~[0-9a-f]{32}$/)
    // 依提示分段读回完整 id 并无损拼接
    const parts: string[] = []
    let offset = 0
    for (let guard = 0; guard < 8; guard += 1) {
      const text = findNodesText([byName], [], handle!, offset)
      const m = text.match(/第 (\d+)\/(\d+) 段（总长 (\d+) 字符）：\n([^\n]+)/)
      expect(m, text).toBeTruthy()
      parts.push(m![4]!)
      const total = Number(m![2]!)
      const cur = Number(m![1]!)
      if (cur >= total) break
      offset = cur + 1
    }
    expect(parts.join('')).toBe(giantId)
  })

  it('id:<前缀> 前缀碰撞时列候选并要求加长；无命中给明确文案（PR #294 评审）', () => {
    const a: CanvasNode = node({
      id: 'x'.repeat(100) + 'a',
      type: 'beat',
      position: { x: 0, y: 0 },
      data: { name: '甲', tone: 'x' },
    })
    const b: CanvasNode = node({
      id: 'x'.repeat(100) + 'b',
      type: 'beat',
      position: { x: 0, y: 0 },
      data: { name: '乙', tone: 'x' },
    })
    const collide = findNodesText([a, b], [], `id:${'x'.repeat(90)}`)
    expect(collide).toContain('前缀不足定位')
    expect(collide).toContain('加长前缀')
    const unique = findNodesText([a, b], [], `id:${'x'.repeat(100)}a`)
    expect(unique).toContain('第 1/1 段')
    expect(unique).toContain('xa')
    const none = findNodesText([a], [], 'id:zzz')
    expect(none).toContain('没有 id 以')
  })

  it('带 ID 指纹的句柄直达碰撞候选完整 id 分段（PR #294 评审）', () => {
    // 两个合法 id 前 100 字符相同：只能按名称发现目标
    const shared = 's'.repeat(100)
    const a: CanvasNode = node({
      id: `${shared}AAA`,
      type: 'beat',
      position: { x: 0, y: 0 },
      data: { name: '甲', tone: 'x' },
    })
    const b: CanvasNode = node({
      id: `${shared}BBB`,
      type: 'beat',
      position: { x: 0, y: 0 },
      data: { name: '乙', tone: 'x' },
    })
    // idHint 的 80 前缀进入碰撞分支：候选项缩写后文本相同，须编号消歧
    const collide = findNodesText([a, b], [], `id:${shared.slice(0, 80)}`)
    expect(collide).toContain('候选按画布顺序编号')
    expect(collide).toContain('- #1 s')
    expect(collide).toContain('- #2 s')
    const handle = collide.match(
      /- #2 [^\n]+find_nodes\("(id:[^"]+)", offset=1\)/,
    )?.[1]
    expect(handle).toMatch(/id:s{80}#2~[0-9a-f]{32}$/)
    // 候选 #2 的句柄读取完整 id
    const full = `${shared}BBB`
    const first = findNodesText([a, b], [], handle!, 0)
    expect(first).toContain(`第 1/1 段（总长 ${full.length} 字符）`)
    expect(first).toContain(full)
    const out = findNodesText([a], [], handle!, 0)
    expect(out).toContain('句柄目标不在当前画布')
  })

  it('多段续读提示保留序号句柄：第二段不再退化为碰撞列表（PR #294 评审）', () => {
    const shared = 's'.repeat(100)
    const giant = 'B'.repeat(8_200)
    const a: CanvasNode = node({
      id: `${shared}AAA`,
      type: 'beat',
      position: { x: 0, y: 0 },
      data: { name: '甲', tone: 'x' },
    })
    const b: CanvasNode = node({
      id: `${shared}${giant}`,
      type: 'beat',
      position: { x: 0, y: 0 },
      data: { name: '乙', tone: 'x' },
    })
    const found = findNodesText([a, b], [], '乙')
    const handle = found.match(/find_nodes\("(id:[^"]+)", offset=1\)/)?.[1]
    expect(handle).toBeTruthy()
    const seg1 = findNodesText([a, b], [], handle!, 1)
    expect(seg1).toContain('第 1/2 段')
    const next = seg1.match(/find_nodes\("(id:[^"]+)", offset=2\)/)?.[1]
    expect(next).toMatch(/id:s{80}#2~[0-9a-f]{32}$/)
    const seg2 = findNodesText([a, b], [], next!, 2)
    expect(seg2).toContain('第 2/2 段')
    expect(seg2).toContain(giant.slice(0, 200))
  })

  it('长基前缀的序号续读仍定位原节点（PR #294 评审）', () => {
    const short = 's'.repeat(80)
    const base = `${short}${'b'.repeat(20)}`
    const distractor = node({
      id: `${short}a`,
      type: 'beat',
      data: { name: '旁支', tone: 'x' },
    })
    const first = node({
      id: `${base}A`,
      type: 'beat',
      data: { name: '甲', tone: 'x' },
    })
    const targetId = `${base}${'B'.repeat(8_200)}`
    const target = node({
      id: targetId,
      type: 'beat',
      data: { name: '乙', tone: 'x' },
    })
    const nodes = [distractor, first, target]
    const found = findNodesText(nodes, [], '乙')
    const emitted = found.match(/find_nodes\("(id:[^"]+)", offset=1\)/)?.[1]
    const fingerprint = emitted?.match(/~[0-9a-f]{32}$/)?.[0]
    expect(fingerprint).toBeTruthy()
    const page1 = findNodesText(nodes, [], `id:${base}#2${fingerprint}`, 1)
    expect(page1).toContain('第 1/2 段')
    const next = page1.match(/find_nodes\("(id:[^"]+)", offset=(\d+)\)/)
    expect(next).toBeTruthy()
    const page2 = findNodesText(nodes, [], next![1]!, Number(next![2]!))
    expect(page2).toContain('第 2/2 段')
    const segments = [
      page1.match(/字符）：\n([^\n]+)/)?.[1],
      page2.match(/字符）：\n([^\n]+)/)?.[1],
    ]
    expect(segments.every((segment) => segment !== undefined)).toBe(true)
    expect(segments.join('')).toBe(targetId)
  })

  it('序号句柄优先于前缀匹配：id 以 #数字 开头不劫持直达（PR #294 评审）', () => {
    const p1: CanvasNode = node({
      id: 'P+A',
      type: 'beat',
      position: { x: 0, y: 0 },
      data: { name: '甲', tone: 'x' },
    })
    const p2: CanvasNode = node({
      id: 'P+B',
      type: 'beat',
      position: { x: 0, y: 0 },
      data: { name: '乙', tone: 'x' },
    })
    const tricky: CanvasNode = node({
      id: 'P#2abc',
      type: 'beat',
      position: { x: 0, y: 0 },
      data: { name: '丙', tone: 'x' },
    })
    // 候选 #2 的新句柄须定位 P+B，不得被 P#2abc 前缀匹配劫持
    const collide = findNodesText([p1, p2, tricky], [], 'id:P')
    const handle = collide.match(
      /- #2 [^\n]+find_nodes\("(id:[^"]+)", offset=1\)/,
    )?.[1]
    expect(handle).toBeTruthy()
    const second = findNodesText([p1, p2, tricky], [], handle!)
    expect(second).toContain('P+B')
    expect(second).not.toContain('P#2abc')
    // 真实含 # 前缀仍可经非纯数字结尾查询
    const literal = findNodesText([p1, p2, tricky], [], 'id:P#2abc')
    expect(literal).toContain('P#2abc')
  })

  it('精确 id 命中优先进入单节点视图：id 子串碰撞不阻连续线枚举（PR #294 评审）', () => {
    // 合法旧项目可同时存在 n1 与 n10：查询 n1 时 includes 也会命中 n10
    const hub: CanvasNode = node({
      id: 'n1',
      type: 'branch',
      position: { x: 0, y: 0 },
      data: {
        prompt: '枢纽',
        options: Array.from({ length: 14 }, (_, i) => ({
          id: `o${i + 1}`,
          label: `出口${i + 1}`,
        })),
      },
    })
    const colliding: CanvasNode = node({
      id: 'n10',
      type: 'beat',
      position: { x: 0, y: 0 },
      data: { name: '旁支', tone: 'x' },
    })
    const edges: Edge[] = Array.from({ length: 14 }, (_, i) => ({
      id: `e${i + 1}`,
      source: 'n1',
      target: `t${i + 1}`,
      type: 'branch',
      sourceHandle: `option-o${i + 1}`,
    }))
    const text = findNodesText([hub, colliding], edges, 'n1')
    // 单节点视图：第 13/14 条出口仍在本页（64/页）可枚举，不再只有前 12 条
    expect(text).toContain('branch(选项出口13): n1 → t13')
    expect(text).toContain('branch(选项出口14): n1 → t14')
    expect(text).not.toContain('单查该节点 id')
  })

  it('合法的 id: 前缀精确 ID 优先进入连线视图（PR #294 评审）', () => {
    const exact = node({
      id: 'id:foo',
      type: 'beat',
      data: { name: '目标', tone: 'x' },
    })
    const other = node({
      id: 'foo',
      type: 'beat',
      data: { name: '旁支', tone: 'x' },
    })
    const edges: Edge[] = Array.from({ length: 14 }, (_, i) => ({
      id: `e${i}`,
      source: 'id:foo',
      target: `t${i}`,
    }))
    const text = findNodesText([exact, other], edges, 'id:foo')
    expect(text).toContain('- id:foo')
    expect(text).toContain('sequence: id:foo → t13')
    expect(text).not.toContain('完整 id 第')
  })

  it('原样精确 ID 优先于首尾空白裁剪，避免读取另一节点的连线（PR #294 评审）', () => {
    const plain = node({
      id: 'n1',
      type: 'beat',
      data: { name: '普通', tone: 'x' },
    })
    const padded = node({
      id: ' n1 ',
      type: 'beat',
      data: { name: '带空白', tone: 'x' },
    })
    const edges: Edge[] = [
      { id: 'plain-edge', source: 'n1', target: 'plain-target' },
      { id: 'padded-edge', source: ' n1 ', target: 'padded-target' },
    ]
    const paddedText = findNodesText([plain, padded], edges, ' n1 ')
    expect(paddedText).toContain('sequence:  n1  → padded-target')
    expect(paddedText).not.toContain('plain-target')

    const plainText = findNodesText([plain, padded], edges, 'n1')
    expect(plainText).toContain('sequence: n1 → plain-target')
    expect(plainText).not.toContain('padded-target')

    const fallbackText = findNodesText([plain], edges.slice(0, 1), ' n1 ')
    expect(fallbackText).toContain('sequence: n1 → plain-target')
  })

  it('长查询续页沿用原始匹配集，不重复或跳过目标（PR #294 评审）', () => {
    const query = 'q'.repeat(61)
    const prefixOnly = node({
      id: 'prefix-only',
      type: 'beat',
      data: { name: query.slice(0, 60), tone: 'x' },
    })
    const matches = Array.from({ length: 25 }, (_, i) =>
      node({
        id: `hit-${i}`,
        type: 'beat',
        data: { name: `${query}-${i}`, tone: 'x' },
      }),
    )
    const nodes = [prefixOnly, ...matches]
    const page1 = findNodesText(nodes, [], query)
    const next = page1.match(/find_nodes\("([^"]+)", offset=(\d+)\)/)
    expect(next).toBeTruthy()
    const page2 = findNodesText(nodes, [], next![1]!, Number(next![2]!))
    expect(page1).toContain('- hit-23')
    expect(page2).toContain('- hit-24')
    expect(page2).not.toContain('- hit-23')
    expect(page2).not.toContain('- prefix-only')
  })

  it('超长查询续页提示保持预算并要求复用原始 query（PR #294 评审）', () => {
    const query = 'q'.repeat(30_000)
    const nodes = Array.from({ length: 25 }, (_, i) =>
      node({
        id: `hit-${i}`,
        type: 'beat',
        data: { name: query, tone: 'x' },
      }),
    )
    const page1 = findNodesText(nodes, [], query)
    expect(page1.length).toBeLessThanOrEqual(GRAPH_DIGEST_MAX_CHARS)
    expect(page1).toContain('原始 query 和 offset=24')
    expect(findNodesText(nodes, [], query, 24)).toContain('- hit-24')
  })

  it('跨工具调用增删同前缀节点时，恢复句柄仍绑定原 ID 或明确失效（PR #294 评审）', () => {
    const prefix = 's'.repeat(80)
    const earlier = node({
      id: `${prefix}A`,
      type: 'beat',
      data: { name: '甲', tone: 'x' },
    })
    const targetId = `${prefix}${'B'.repeat(8_200)}`
    const target = node({
      id: targetId,
      type: 'beat',
      data: { name: '目标', tone: 'x' },
    })
    const added = node({
      id: `${prefix}0`,
      type: 'beat',
      data: { name: '新增', tone: 'x' },
    })
    const found = findNodesText([earlier, target], [], '目标')
    const handle = found.match(/find_nodes\("(id:[^"]+)", offset=1\)/)?.[1]
    expect(handle).toMatch(/#2~[0-9a-f]{32}$/)
    const firstAfterAdd = findNodesText(
      [added, earlier, target],
      [],
      handle!,
      1,
    )
    expect(firstAfterAdd).toContain('第 1/2 段')
    expect(firstAfterAdd).toContain('B'.repeat(200))
    const page1 = findNodesText([earlier, target], [], handle!, 1)
    const next = page1.match(/find_nodes\("(id:[^"]+)", offset=2\)/)?.[1]
    expect(next).toBeTruthy()
    const page2 = findNodesText([added, earlier, target], [], next!, 2)
    expect(page2).toContain('第 2/2 段')
    expect(page2).toContain('B'.repeat(200))
    const removed = findNodesText([added, earlier], [], next!, 2)
    expect(removed).toContain('句柄目标不在当前画布')
    expect(removed).not.toContain('完整 id 第')
  })

  it('超长 ID 的连线续页使用可解析句柄并保持目标（PR #294 评审）', () => {
    const targetId = 'z'.repeat(100)
    const target = node({
      id: targetId,
      type: 'beat',
      data: { name: '枢纽', tone: 'x' },
    })
    const added = node({
      id: `${'z'.repeat(80)}a`,
      type: 'beat',
      data: { name: '新增', tone: 'x' },
    })
    const edges: Edge[] = Array.from({ length: 70 }, (_, i) => ({
      id: `e${i}`,
      source: targetId,
      target: `t${i}`,
    }))
    const page1 = findNodesText([target], edges, '枢纽')
    const next = page1.match(
      /find_nodes\("(node:[^"]+)", offset=(\d+), cursor="([0-9a-f]+)"\)/,
    )
    expect(next?.[1]).toMatch(/~[0-9a-f]{32}$/)
    const page2 = findNodesText(
      [added, target],
      edges,
      next![1]!,
      Number(next![2]!),
      next![3]!,
    )
    expect(page2).toContain('→ t64')
    expect(page2).toContain('→ t69')
    expect(page2).not.toContain('→ t63')
    const removed = findNodesText(
      [added],
      edges,
      next![1]!,
      Number(next![2]!),
      next![3]!,
    )
    expect(removed).toContain('句柄目标不在当前画布')
    expect(removed).not.toContain('→ t64')
  })

  it('句柄提示转义合法 ID 中的引号与换行（PR #294 评审）', () => {
    const id = `q"\n${'x'.repeat(100)}`
    const target = node({
      id,
      type: 'beat',
      data: { name: '特殊 ID', tone: 'x' },
    })
    const found = findNodesText([target], [], '特殊 ID')
    const encoded = found.match(
      /find_nodes\(("(?:\\.|[^"\\])*"), offset=1\)/,
    )?.[1]
    expect(encoded).toBeTruthy()
    const query = JSON.parse(encoded!) as string
    expect(findNodesText([target], [], query)).toContain(id)
  })

  it('旧位置句柄不再静默解析到可能变化的节点（PR #294 评审）', () => {
    const a = node({ id: 'P-A', type: 'beat', data: { name: '甲', tone: 'x' } })
    const b = node({ id: 'P-B', type: 'beat', data: { name: '乙', tone: 'x' } })
    const text = findNodesText([a, b], [], 'id:P-#2')
    expect(text).toContain('旧序号句柄')
    expect(text).not.toContain('P-B')
  })

  it('损坏的句柄明确失败，不退回模糊检索（PR #294 评审）', () => {
    const target = node({
      id: 'n1',
      type: 'beat',
      data: { name: 'node:broken#2~bad', tone: 'x' },
    })
    expect(findNodesText([target], [], 'node:broken#2~bad', 64)).toContain(
      '无效节点句柄',
    )
    expect(findNodesText([target], [], 'id:broken#2~bad')).toContain(
      '无效或过期句柄',
    )
  })

  it('无匹配与空关键词给出明确文案，不抛异常', () => {
    const { nodes, edges } = fixture()
    expect(findNodesText(nodes, edges, '不存在')).toContain('未找到匹配')
    expect(findNodesText(nodes, edges, '')).toContain('query')
  })
})
