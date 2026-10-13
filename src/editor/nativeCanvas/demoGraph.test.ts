// @vitest-environment happy-dom
/**
 * P1 原生视觉首片的演示夹具契约（docs/swiftui-react-flow-migration-plan.md
 * §5 P1 第 3 项）：确定性、脱敏、覆盖全部注册节点类型，且图本身能通过
 * 交互连线同一套 graphRules 校验——夹具里放一条「保存后即被静默删除」的
 * 边会让原生首片展示坏图。纯数据模块，不涉渲染。
 */
import { describe, expect, it } from 'vitest'
import { DEMO_GRAPH_LABEL, demoGraph } from './demoGraph'
import {
  connectionEndpointIssue,
  edgeKindOf,
  wouldCreateCycle,
} from '../graphRules'
import { beatFulfillmentMap } from '../outline'
import { canvasNodeTypes } from '../canvasRegistry'

describe('demoGraph 演示夹具（P1 原生视觉首片）', () => {
  it('节点 id 唯一且类型全部在画布注册表中', () => {
    const { nodes } = demoGraph()
    const ids = new Set(nodes.map((n) => n.id))
    expect(ids.size).toBe(nodes.length)
    for (const node of nodes) {
      expect(
        Object.prototype.hasOwnProperty.call(canvasNodeTypes, node.type),
      ).toBe(true)
    }
  })

  it('每条边端点存在并通过端点/成环规则（与交互连线同一套判定）', () => {
    const { nodes, edges } = demoGraph()
    const typeOf = new Map(nodes.map((n) => [n.id, n.type]))
    const flowEdges: Array<{ source: string; target: string }> = []
    for (const edge of edges) {
      expect(typeOf.has(edge.source)).toBe(true)
      expect(typeOf.has(edge.target)).toBe(true)
      const kind = edgeKindOf(edge)
      expect(
        connectionEndpointIssue(
          typeOf.get(edge.source),
          typeOf.get(edge.target),
          kind,
        ),
      ).toBeNull()
      if (kind === 'attach') continue // attach 是垂直派生边，不参与剧情流成环
      expect(wouldCreateCycle(flowEdges, edge.source, edge.target)).toBe(false)
      flowEdges.push(edge)
    }
  })

  it('覆盖全部注册节点类型与三种连线语义', () => {
    const { nodes, edges } = demoGraph()
    const usedTypes = new Set<string>(nodes.map((n) => n.type))
    for (const type of Object.keys(canvasNodeTypes)) {
      expect(usedTypes.has(type)).toBe(true)
    }
    const usedKinds = new Set(edges.map((e) => edgeKindOf(e)))
    expect(usedKinds.has('sequence')).toBe(true)
    expect(usedKinds.has('branch')).toBe(true)
    expect(usedKinds.has('attach')).toBe(true)
  })
})

describe('演示夹具引用与确定性', () => {
  it('设定集引用全部可解析（地点/在场角色/说话人）', () => {
    const { nodes, edges, settings } = demoGraph()
    const locationIds = new Set(settings.locations.map((l) => l.id))
    const characterIds = new Set(settings.characters.map((c) => c.id))
    for (const node of nodes) {
      const data = node.data as Record<string, unknown>
      if (typeof data.locationId === 'string') {
        expect(locationIds.has(data.locationId)).toBe(true)
      }
      for (const cid of (data.characterIds as string[]) ?? []) {
        expect(characterIds.has(cid)).toBe(true)
      }
      for (const line of (data.lines as Array<{ speaker?: string }>) ?? []) {
        if (line.speaker !== undefined) {
          expect(characterIds.has(line.speaker)).toBe(true)
        }
      }
    }
    // 端点引用的节点必然存在已由上一用例覆盖；这里同时约束边非空
    expect(edges.length).toBeGreaterThan(0)
  })

  it('夹具确定性：两次构造深相等', () => {
    expect(demoGraph()).toEqual(demoGraph())
  })

  it('演示标记非空且节拍兑现派生可用', () => {
    expect(DEMO_GRAPH_LABEL.length).toBeGreaterThan(0)
    const { nodes, edges } = demoGraph()
    const beats = nodes.filter((n) => n.type === 'beat')
    const fulfillment = beatFulfillmentMap(nodes, edges)
    for (const beat of beats) {
      expect(fulfillment.has(beat.id)).toBe(true)
    }
  })
})
