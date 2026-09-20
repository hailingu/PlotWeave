/**
 * 归一化性质测试（issue #232）的共享构件：fast-check 全局配置、基础
 * 有界生成器（保全值/小池身份/短文本/数字/ISO 串）与输出不变量断言
 * （身份唯一/逐边图规则/全图边规则/集标题契约），供 convert.property
 * 测试族各文件共用。规模与语义约束见各测试文件头部说明。
 */
import fc from 'fast-check'
import { expect } from 'vitest'
import type { ProjectContent } from './content'
import { edgeKindOf, SCENE_SHOT_HANDLE } from '../editor/graphRules'
import { trimTitleWhitespace } from './titleWhitespace'

/** fast-check 全局配置注入（PROPERTY_SEED 精确复现 / PROPERTY_RUNS 调
 * 迭代数）；各测试文件在 beforeAll 中调用。 */
export function configurePropertyGlobal(): void {
  const seedEnv = process.env.PROPERTY_SEED
  const runsEnv = process.env.PROPERTY_RUNS
  fc.configureGlobal({
    numRuns: runsEnv !== undefined ? Number(runsEnv) : 100,
    ...(seedEnv !== undefined ? { seed: Number(seedEnv) } : {}),
  })
}

/** 受限字母表保全值（非空、无空白、非标点）：空名/空白名/空文件名是
 * 归一化修复的合法目标，不在「原样存活」预期内（保全预言机与 v0 迁移
 * 存活断言共用）。 */
export const preservedText = fc
  .array(fc.constantFrom('a', 'b', 'c', '1', '2', '丹'), {
    minLength: 1,
    maxLength: 6,
  })
  .map((chars) => chars.join(''))

/** 小池身份（0–4）：天然产生重复/碰撞（归一化重发路径的脏输入源）；
 * 尾号 8/9（约 2/10）落入空白族身份——空串与纯空白串均属 §8.1 共同
 * 值域（trim 后非空）之外的非法 id，空键/空白键重发路径均被行使。 */
export const idArb = (prefix: string) =>
  fc
    .tuple(fc.nat(9), fc.constantFrom('', ' ', ' \t', '\u3000'))
    .map(([n, blank]) => (n >= 8 ? blank : `${prefix}${n}`))

export const shortText = fc.string({ minLength: 0, maxLength: 8 })
export const finiteNumber = fc.double({ min: -1000, max: 1000, noNaN: true })
export const isoText = fc
  .nat(27)
  .map((day) => `2026-01-${String(day + 1).padStart(2, '0')}T00:00:00.000Z`)

/** 任意生成器的取值类型推断（fc.Arbitrary<T> 的条件展开）。 */
export type ArbValue<A> = A extends fc.Arbitrary<infer T> ? T : never

/** 身份唯一不变量（issue #232）：全部生成身份域按 §8.1 共同值域判定
 * 非空白（`trim()` 后非空——纯空白串与空串同属非法 id）且唯一 + 资产索引
 * 键与值内 id 一致。 */
function assertIdentityInvariants(content: ProjectContent): void {
  const domains: Array<[string, string[]]> = [
    ['节点', content.nodes.map((n) => n.id)],
    ['边', content.edges.map((e) => e.id)],
    ['角色', content.settings.characters.map((e) => e.id)],
    ['地点', content.settings.locations.map((e) => e.id)],
    ['道具', (content.settings.props ?? []).map((e) => e.id)],
    ['设定文档', (content.settings.documents ?? []).map((e) => e.id)],
    ['资产索引', Object.values(content.assets?.byId ?? {}).map((a) => a.id)],
  ]
  for (const [label, ids] of domains) {
    expect(
      ids.every((id) => id.trim().length > 0),
      `${label} id 非空白`,
    ).toBe(true)
    expect(new Set(ids).size, `${label} id 唯一`).toBe(ids.length)
  }
  // 资产记录键与值内 id 逐项相等（评审第三轮修复：集合相等会放行键值
  // 置换 {a: {id: 'b'}, b: {id: 'a'}}，违反记录键为权威 id 的不变量）
  for (const [key, asset] of Object.entries(content.assets?.byId ?? {})) {
    expect(asset.id, `资产 ${key} 的值内 id 与记录键一致`).toBe(key)
  }
  for (const n of content.nodes) {
    if (n.type === 'dialogue') {
      const ids = n.data.lines.map((line) => line.id)
      expect(
        ids.every((id) => id.trim().length > 0),
        '对白行 id 非空白',
      ).toBe(true)
      expect(new Set(ids).size, '对白行 id 唯一').toBe(ids.length)
    }
    if (n.type === 'branch') {
      const ids = n.data.options.map((o) => o.id)
      expect(
        ids.every((id) => id.trim().length > 0),
        '分支选项 id 非空白',
      ).toBe(true)
      expect(new Set(ids).size, '分支选项 id 唯一').toBe(ids.length)
    }
    if (n.type === 'shot') {
      const ids = n.data.refs.map((r) => r.id)
      expect(
        ids.every((id) => id.trim().length > 0),
        '分镜引用位 id 非空白',
      ).toBe(true)
      expect(new Set(ids).size, '分镜引用位 id 唯一').toBe(ids.length)
    }
  }
}

/** 逐边图规则（§4.4/§5，判定复用运行态 edgeKindOf——孤儿边隔离的后置
 * 条件）：端点存在、非自环、attach/branch/sequence 形态与句柄契约——
 * 含 §5 匿名端口契约（评审第十六轮）：targetHandle 不可绑定（任何边
 * 种类，归一化须剥离）、sequence 边不得携带 sourceHandle。 */
function assertPerEdgeRules(content: ProjectContent): void {
  const liveIds = new Set(content.nodes.map((n) => n.id))
  const nodesById = new Map(content.nodes.map((n) => [n.id, n]))
  for (const e of content.edges) {
    expect(liveIds.has(e.source), `活动边 ${e.id} 的 source 指向存在节点`).toBe(
      true,
    )
    expect(liveIds.has(e.target), `活动边 ${e.id} 的 target 指向存在节点`).toBe(
      true,
    )
    expect(
      e.targetHandle,
      `边 ${e.id} 的 targetHandle 已剥离（匿名端口不可绑定）`,
    ).toBeUndefined()
    expect(e.source, `边 ${e.id} 非自环`).not.toBe(e.target)
    const src = nodesById.get(e.source)
    const dst = nodesById.get(e.target)
    const kind = edgeKindOf(e)
    if (kind === 'sequence') {
      expect(
        e.sourceHandle,
        `sequence 边 ${e.id} 的 sourceHandle 已剥离（匿名端口不可绑定）`,
      ).toBeUndefined()
    }
    if (kind === 'attach') {
      expect(e.sourceHandle, `attach 边 ${e.id} 句柄为 shots 端口`).toBe(
        SCENE_SHOT_HANDLE,
      )
      expect(src?.type, `attach 边 ${e.id} 从场景发起`).toBe('scene')
      expect(dst?.type, `attach 边 ${e.id} 挂到分镜卡`).toBe('shot')
      continue
    }
    expect(src?.type, `剧情流边 ${e.id} 不以分镜卡/图片为端点`).not.toBe('shot')
    expect(src?.type).not.toBe('image')
    expect(dst?.type, `剧情流边 ${e.id} 不以分镜卡/图片为端点`).not.toBe('shot')
    expect(dst?.type).not.toBe('image')
    if (kind === 'branch') {
      expect(src?.type, `branch 边 ${e.id} 从分支节点引出`).toBe('branch')
      const optionId = e.sourceHandle?.startsWith('option-')
        ? e.sourceHandle.slice('option-'.length)
        : undefined
      expect(
        optionId !== undefined &&
          src?.type === 'branch' &&
          src.data.options.some((o) => o.id === optionId),
        `branch 边 ${e.id} 的句柄解析到源节点的现存选项`,
      ).toBe(true)
    } else {
      expect(
        src?.type,
        `sequence 边 ${e.id} 不从分支节点匿名端口引出`,
      ).not.toBe('branch')
    }
  }
}

/** 全图边规则（§11.1 第 3 步/§11.3 隔离的后置条件）：逻辑重复元组唯一、
 * attach 宿主唯一、剧情流有向无环（attach 垂直从属不参与环检测）。 */
function assertGraphLevelRules(content: ProjectContent): void {
  const endpointKeys = content.edges.map((e) =>
    JSON.stringify([e.source, e.target, e.sourceHandle ?? '']),
  )
  expect(
    new Set(endpointKeys).size,
    '活动边端点/句柄元组唯一（无逻辑重复）',
  ).toBe(endpointKeys.length)
  const attachHosts = content.edges
    .filter((e) => edgeKindOf(e) === 'attach')
    .map((e) => e.target)
  expect(new Set(attachHosts).size, 'attach 宿主唯一').toBe(attachHosts.length)
  const flowAdj = new Map<string, string[]>()
  for (const e of content.edges) {
    if (edgeKindOf(e) === 'attach') continue
    const list = flowAdj.get(e.source)
    if (list) list.push(e.target)
    else flowAdj.set(e.source, [e.target])
  }
  const visited = new Set<string>()
  const onPath = new Set<string>()
  const hasCycle = (node: string): boolean => {
    if (onPath.has(node)) return true
    if (visited.has(node)) return false
    visited.add(node)
    onPath.add(node)
    for (const next of flowAdj.get(node) ?? []) {
      if (hasCycle(next)) return true
    }
    onPath.delete(node)
    return false
  }
  expect(
    [...flowAdj.keys()].every((start) => !hasCycle(start)),
    '剧情流边构成有向无环图',
  ).toBe(true)
}

/** 集标题契约（§4.1/§11.1）：键为规范十进制正整数（"01"/"1e0"/" 1" 等
 * 非规范书写由归一化删除，折叠覆盖亦不被接受），标题去规范空白后非空——
 * 判定复用生产侧 trimTitleWhitespace（与 Rust 保存边界对齐的超集裁剪）。 */
function assertEpisodeTitles(content: ProjectContent): void {
  for (const [key, title] of Object.entries(content.episodeTitles ?? {})) {
    expect(
      /^[1-9]\d*$/.test(key) && Number.isSafeInteger(Number(key)),
      `集标题键 ${key} 为规范十进制正整数`,
    ).toBe(true)
    expect(title.trim().length > 0, `集 ${key} 标题非空白`).toBe(true)
    expect(title, `集 ${key} 标题首尾无规范空白`).toBe(
      trimTitleWhitespace(title),
    )
  }
}

/** 输出不变量总装（issue #232）：身份唯一、活动边满足图规则、集标题契约。 */
export function assertOutputInvariants(content: ProjectContent): void {
  assertIdentityInvariants(content)
  assertPerEdgeRules(content)
  assertGraphLevelRules(content)
  assertEpisodeTitles(content)
}
