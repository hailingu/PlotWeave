// @vitest-environment happy-dom
/**
 * M15 性能夹具契约（docs/swiftui-react-flow-migration-plan.md §7.2，
 * issue #523）：固定规模的确定性脱敏图，规模、家族比例与边数可预告，
 * 且与交互连线共用同一套 graphRules 判定——夹具里放一条「保存后即被
 * 静默删除」的边会让性能测量建立在坏图上。纯数据模块，不涉渲染。
 */
import { describe, expect, it } from 'vitest'
import {
  CANVAS_PERF_IMAGE_RESOLUTION,
  CANVAS_PERF_SCALES,
  canvasPerfFixture,
  parseCanvasPerfHash,
} from './canvasPerfFixture'
import {
  branchOptionIdOf,
  connectionEndpointIssue,
  edgeKindOf,
  wouldCreateCycle,
} from '../graphRules'
import { beatFulfillmentMap } from '../outline'
import { canvasNodeTypes } from '../canvasRegistry'

describe('canvasPerfFixture 固定规模夹具（M15）', () => {
  for (const scale of CANVAS_PERF_SCALES) {
    it(`规模 ${scale}：id 唯一、类型全部注册、规模与比例可预告`, () => {
      const { nodes, edges } = canvasPerfFixture(scale)
      expect(nodes).toHaveLength(scale)
      // 每单元 10 节点 9 边，首单元缺 1 条跨单元桥接边。
      expect(edges).toHaveLength((scale / 10) * 9 - 1)
      const ids = new Set(nodes.map((n) => n.id))
      expect(ids.size).toBe(nodes.length)
      for (const node of nodes) {
        expect(
          Object.prototype.hasOwnProperty.call(canvasNodeTypes, node.type),
        ).toBe(true)
      }
      const typeCount = new Map<string, number>()
      for (const node of nodes) {
        typeCount.set(node.type, (typeCount.get(node.type) ?? 0) + 1)
      }
      expect(typeCount.get('beat')).toBe((scale / 10) * 3)
      expect(typeCount.get('scene')).toBe((scale / 10) * 2)
      expect(typeCount.get('dialogue')).toBe((scale / 10) * 2)
      expect(typeCount.get('branch')).toBe(scale / 10)
      expect(typeCount.get('shot')).toBe(scale / 10)
      expect(typeCount.get('image')).toBe(scale / 10)
    })

    it(`规模 ${scale}：每条边端点存在并通过端点/成环规则`, () => {
      const { nodes, edges } = canvasPerfFixture(scale)
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
        if (kind === 'attach') continue
        expect(wouldCreateCycle(flowEdges, edge.source, edge.target)).toBe(
          false,
        )
        flowEdges.push(edge)
      }
    })

    it(`规模 ${scale}：branch 边选项句柄与源分支节点的选项 id 对齐`, () => {
      // 句柄与选项 id 不同源时，真实 React Flow 找不到出口端口、选项边
      // 不渲染（Swift 真 WebKit 套件首次执行时抓到过该缺陷）。
      const { nodes, edges } = canvasPerfFixture(scale)
      const optionsOf = new Map(
        nodes
          .filter((n) => n.type === 'branch')
          .map((node) => {
            const optionIds = new Set(
              (
                (node.data as { options?: Array<{ id: string }> }).options ?? []
              ).map((option) => option.id),
            )
            return [node.id, optionIds] as const
          }),
      )
      for (const edge of edges.filter((e) => e.type === 'branch')) {
        const options = optionsOf.get(edge.source)
        expect(options, `branch 边 ${edge.id} 的源必须是分支节点`).toBeDefined()
        const optionId = branchOptionIdOf(edge.sourceHandle ?? '')
        expect(
          optionId !== undefined &&
            (options ?? new Set<string>()).has(optionId),
          `branch 边 ${edge.id} 的句柄 ${edge.sourceHandle} 必须对应源节点选项`,
        ).toBe(true)
      }
    })

    it(`规模 ${scale}：设定集引用可解析、确定性深相等、无演示数据泄漏`, () => {
      const first = canvasPerfFixture(scale)
      const second = canvasPerfFixture(scale)
      expect(first).toEqual(second)
      expect(first.nodes).not.toBe(second.nodes)
      const locationIds = new Set(first.settings.locations.map((l) => l.id))
      const characterIds = new Set(first.settings.characters.map((c) => c.id))
      for (const node of first.nodes) {
        expect(node.id.startsWith('demo-')).toBe(false)
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
      const fulfillment = beatFulfillmentMap(first.nodes, first.edges)
      for (const beat of first.nodes.filter((n) => n.type === 'beat')) {
        expect(fulfillment.has(beat.id)).toBe(true)
      }
    })
  }

  it('图片节点声明固定分辨率且不携带媒体字节', () => {
    const { nodes } = canvasPerfFixture(100)
    const images = nodes.filter((n) => n.type === 'image')
    expect(images.length).toBeGreaterThan(0)
    for (const node of images) {
      expect((node.data as { size?: string }).size).toBe(
        CANVAS_PERF_IMAGE_RESOLUTION,
      )
      expect((node.data as { outputs?: unknown }).outputs).toEqual({})
    }
  })

  it('hash 解析只接受已登记规模', () => {
    expect(parseCanvasPerfHash('#perf:100')).toBe(100)
    expect(parseCanvasPerfHash('#perf:1000')).toBe(1000)
    expect(parseCanvasPerfHash('#perf:250')).toBeNull()
    expect(parseCanvasPerfHash('#fixture')).toBeNull()
    expect(parseCanvasPerfHash('')).toBeNull()
    expect(parseCanvasPerfHash('#perf:abc')).toBeNull()
  })
})
