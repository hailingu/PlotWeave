// @vitest-environment happy-dom
/**
 * M15 性能夹具契约（docs/swiftui-react-flow-migration-plan.md §7.2，
 * issue #523）：固定规模的确定性脱敏图，规模、家族比例与边数可预告，
 * 且与交互连线共用同一套 graphRules 判定——夹具里放一条「保存后即被
 * 静默删除」的边会让性能测量建立在坏图上。断言体提取为独立函数，
 * 满足工程规范的 80 行可执行单元上限（PR #574 评审）。
 */
import { describe, expect, it } from 'vitest'
import {
  CANVAS_PERF_IMAGE_RESOLUTION,
  CANVAS_PERF_SCALES,
  canvasPerfFixture,
  parseCanvasPerfHash,
  type CanvasPerfScale,
} from './canvasPerfFixture'
import {
  branchOptionIdOf,
  connectionEndpointIssue,
  edgeKindOf,
  wouldCreateCycle,
} from '../graphRules'
import { beatFulfillmentMap } from '../outline'
import { canvasNodeTypes } from '../canvasRegistry'

/** 规模、id 唯一性与六类节点家族的固定比例。 */
function expectScaleShape(scale: CanvasPerfScale): void {
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
}

/** 端点存在性、端点规则与剧情流无环（与交互连线同一套判定）。 */
function expectScaleEdgesValid(scale: CanvasPerfScale): void {
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
    expect(wouldCreateCycle(flowEdges, edge.source, edge.target)).toBe(false)
    flowEdges.push(edge)
  }
}

/** branch 边句柄与源分支节点选项 id 对齐：句柄与选项 id 不同源时，
 * 真实 React Flow 找不到出口端口、选项边不渲染（Swift 真 WebKit 套件
 * 首次执行时抓到过该缺陷）。 */
function expectScaleBranchHandlesAligned(scale: CanvasPerfScale): void {
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
      optionId !== undefined && (options ?? new Set<string>()).has(optionId),
      `branch 边 ${edge.id} 的句柄 ${edge.sourceHandle} 必须对应源节点选项`,
    ).toBe(true)
  }
}

/** 设定集引用可解析、确定性深相等、无演示数据泄漏与节拍兑现派生。 */
function expectScaleReferencesAndDeterminism(scale: CanvasPerfScale): void {
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
}

/** 图片节点声明固定分辨率且不携带媒体字节。 */
function expectImageNodesSynthetic(): void {
  const { nodes } = canvasPerfFixture(100)
  const images = nodes.filter((n) => n.type === 'image')
  expect(images.length).toBeGreaterThan(0)
  for (const node of images) {
    expect((node.data as { size?: string }).size).toBe(
      CANVAS_PERF_IMAGE_RESOLUTION,
    )
    expect((node.data as { outputs?: unknown }).outputs).toEqual({})
  }
}

/** hash 解析只接受已登记规模。 */
function expectPerfHashParsing(): void {
  expect(parseCanvasPerfHash('#perf:100')).toBe(100)
  expect(parseCanvasPerfHash('#perf:1000')).toBe(1000)
  expect(parseCanvasPerfHash('#perf:250')).toBeNull()
  expect(parseCanvasPerfHash('#fixture')).toBeNull()
  expect(parseCanvasPerfHash('')).toBeNull()
  expect(parseCanvasPerfHash('#perf:abc')).toBeNull()
}

describe('canvasPerfFixture 固定规模夹具（M15）', () => {
  for (const scale of CANVAS_PERF_SCALES) {
    it(`规模 ${scale}：id 唯一、类型全部注册、规模与比例可预告`, () => {
      expectScaleShape(scale)
    })
    it(`规模 ${scale}：每条边端点存在并通过端点/成环规则`, () => {
      expectScaleEdgesValid(scale)
    })
    it(`规模 ${scale}：branch 边选项句柄与源分支节点的选项 id 对齐`, () => {
      expectScaleBranchHandlesAligned(scale)
    })
    it(`规模 ${scale}：设定集引用可解析、确定性深相等、无演示数据泄漏`, () => {
      expectScaleReferencesAndDeterminism(scale)
    })
  }
  it('图片节点声明固定分辨率且不携带媒体字节', () => {
    expectImageNodesSynthetic()
  })
  it('hash 解析只接受已登记规模', () => {
    expectPerfHashParsing()
  })
})
