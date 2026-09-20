/**
 * 归一化不变量的生成式验证（issue #232）：v0 迁移与拒绝边界——v0 旧
 * 扁平信封的迁移链行使与载荷/设定/边保全断言，及版本边界拒绝行为。
 * 可复现性与规模约束见 convert.property.test.ts 头部说明（共享构件
 * 在 convert.property.shared.ts）。
 */
import fc from 'fast-check'
import { beforeAll, describe, expect, it } from 'vitest'
import { parseProject, serializeProject } from './convert'
import { CURRENT_SCHEMA_VERSION } from './document'
import type { ProjectContent } from './content'
import { NOW } from './convertFixtures'
import { edgeKindOf } from '../editor/graphRules'
import {
  configurePropertyGlobal,
  idArb,
  preservedText,
  shortText,
  finiteNumber,
  type ArbValue,
  assertOutputInvariants,
} from './convert.property.shared'

const PROJECT_ID = 'p-prop'

beforeAll(configurePropertyGlobal)

/** v0 branch 节点规格：属性化生成后由性质以固定 id `br0` 组装（保证
 * 迁移目标存在），选项 id 唯一化（迁移路径的干净前置）。 */
const v0BranchSpecArb = fc.record({
  prompt: shortText,
  optionLabels: fc.array(shortText, { maxLength: 3 }),
})
const v0SceneArb = fc.record({
  id: idArb('n'),
  type: fc.constant('scene'),
  position: fc.record({ x: finiteNumber, y: finiteNumber }),
  data: fc.record({
    name: shortText,
    sceneNo: fc.nat(3),
    interior: fc.boolean(),
    synopsis: shortText,
  }),
})
/** 旧版 option-N 下标句柄边（§11.1 迁移链的迁移目标）：optionIdx 取值
 * 覆盖在界与越界（越界句柄按孤儿边隔离，属允许的修复）。 */
const v0BranchEdgeArb = fc.record({
  id: idArb('be'),
  targetIdx: fc.nat(4),
  optionIdx: fc.nat(3),
})
const v0EnvelopeArb = fc.record({
  branch: v0BranchSpecArb,
  scenes: fc.array(v0SceneArb, { maxLength: 4 }),
  flowEdgeSpecs: fc.array(
    fc.record({ sourceIdx: fc.nat(4), targetIdx: fc.nat(4) }),
    { maxLength: 4 },
  ),
  branchEdges: fc.array(v0BranchEdgeArb, { maxLength: 3 }),
  // 角色（评审第八轮）：确定性唯一身份 + 保全值，迁移存活可精确断言；
  // 脏角色路径已由 v1 性质覆盖。保底非空（评审第十二轮）：文档 relatedIds
  // 与对白 speaker 直引需要确定存在的 ch0/loc0 目标
  characterNames: fc.array(preservedText, { minLength: 1, maxLength: 3 }),
  locationNames: fc.array(preservedText, { minLength: 1, maxLength: 3 }),
  propNames: fc.array(preservedText, { maxLength: 3 }),
  documentSpecs: fc.array(
    fc.record({
      title: preservedText,
      withLocation: fc.boolean(),
    }),
    { maxLength: 3 },
  ),
  // 空白 id 角色（评审第十二轮）：存在时行使数组期空白重发 +
  // relatedIds/speaker 的「空白原值 → 新 id」映射改写路径
  blankCharacter: fc.option(preservedText, { nil: undefined }),
  // 对白/分镜（评审第十二轮）：migrateDialogueNode/migrateShotNode 的行使
  // 源——对象 speaker（头像标签解析）、字符串直引、无说话人三形态；
  // 分镜引用位覆盖 assetId 与 label 两形
  dialogues: fc.array(
    fc.record({
      name: preservedText,
      lines: fc.array(
        fc.record({
          text: preservedText,
          speaker: fc.constantFrom('object', 'string', 'none'),
          speakerNameIdx: fc.nat(2),
        }),
        { minLength: 1, maxLength: 3 },
      ),
    }),
    { maxLength: 2 },
  ),
  shots: fc.array(
    fc.record({
      picture: preservedText,
      withAssetRef: fc.boolean(),
    }),
    { maxLength: 2 },
  ),
})

/** v0 边组装（评审第七轮拆分）：普通剧情流边按下标引用真实节点（评审
 * 第六轮：n* 池端点与组装后节点恒不相遇、全部被端点守卫隔离，保全路径
 * 空转）；前向序 + 源非 branch（sequence 端点约束），碰撞出的非法形态
 * 不生成。branch 边带运行态判别器（评审第五轮：缺 type: 'branch' 时迁移
 * 后被分类为 sequence、按「branch 节点不得引出匿名边」隔离，幸存环恒
 * 空转）；目标按下标引用真实节点，指向 br0 的自环边不生成。 */
function assembleV0Edges(
  v0: ArbValue<typeof v0EnvelopeArb>,
  docNodes: Array<Record<string, unknown>>,
): {
  flowEdges: Array<Record<string, unknown>>
  branchEdges: Array<Record<string, unknown>>
} {
  const flowEdges: Array<Record<string, unknown>> = []
  v0.flowEdgeSpecs.forEach((spec) => {
    const src = docNodes[spec.sourceIdx] as
      { id?: unknown; type?: unknown } | undefined
    const dst = docNodes[spec.targetIdx] as { id?: unknown } | undefined
    if (src === undefined || dst === undefined) return
    if (spec.sourceIdx >= spec.targetIdx) return
    if (src.id === dst.id || src.type === 'branch') return
    flowEdges.push({
      id: `fe${flowEdges.length}`,
      source: src.id,
      target: dst.id,
    })
  })
  const branchEdges: Array<Record<string, unknown>> = []
  v0.branchEdges.forEach((e) => {
    const target = docNodes[e.targetIdx] as { id?: unknown } | undefined
    if (target === undefined || target.id === 'br0') return
    branchEdges.push({
      id: `be${branchEdges.length}`,
      type: 'branch' as const,
      source: 'br0',
      target: target.id,
      sourceHandle: `option-${e.optionIdx}`,
    })
  })
  return { flowEdges, branchEdges }
}

/** v0 对白/分镜节点组装（评审第十二轮）：追加在 docNodes 之后——下标边
 * 寻址数组恒为 [br0, s0..]，新增节点不影响既有边组装语义；两类节点不
 * 连边，专注迁移载荷与身份断言。speaker 对象形态的标签取自角色桶
 * （gradient 全 'g'，ensureCharacter 精确匹配首见胜），解析结果确定可
 * 断言。 */
function assembleV0ListNodes(
  v0: ArbValue<typeof v0EnvelopeArb>,
): Array<Record<string, unknown>> {
  const dialogueNodes = v0.dialogues.map((d, i) => ({
    id: `dl${i}`,
    type: 'dialogue',
    position: { x: 0, y: 0 },
    data: {
      name: d.name,
      lines: d.lines.map((l, j) => ({
        id: `dl${i}-${j}`,
        kind: 'line',
        text: l.text,
        ...(l.speaker === 'object'
          ? {
              speaker: {
                label:
                  v0.characterNames[
                    l.speakerNameIdx % v0.characterNames.length
                  ],
                gradient: 'g',
              },
            }
          : {}),
        ...(l.speaker === 'string' ? { speaker: 'ch0' } : {}),
      })),
    },
  }))
  const shotNodes = v0.shots.map((s, i) => ({
    id: `sh${i}`,
    type: 'shot',
    position: { x: 0, y: 0 },
    data: {
      shotNo: i + 1,
      size: '中景',
      picture: s.picture,
      prompt: `分镜${i}`,
      refs: [
        s.withAssetRef
          ? { id: `sr${i}`, kind: 'character', assetId: 'a0' }
          : { id: `sr${i}`, kind: 'audio', label: s.picture },
      ],
    },
  }))
  return [...dialogueNodes, ...shotNodes]
}

/** v0 设定桶组装（评审第十二轮）：数组形态四桶全部生成——空白 id 角色
 * 行使数组期重发，其空白原值在文档 relatedIds 中的引用经映射改写。 */
function assembleV0Settings(
  v0: ArbValue<typeof v0EnvelopeArb>,
): Record<string, unknown> {
  return {
    characters: [
      ...v0.characterNames.map((name, i) => ({
        id: `ch${i}`,
        name,
        gradient: 'g',
      })),
      ...(v0.blankCharacter !== undefined
        ? [{ id: '', name: v0.blankCharacter, gradient: 'g' }]
        : []),
    ],
    locations: v0.locationNames.map((name, i) => ({
      id: `loc${i}`,
      name,
    })),
    props: v0.propNames.map((name, i) => ({ id: `prop${i}`, name })),
    documents: v0.documentSpecs.map((d, i) => ({
      id: `doc${i}`,
      title: d.title,
      body: '正文',
      relatedIds: [
        { kind: 'character', id: 'ch0' },
        ...(d.withLocation ? [{ kind: 'location', id: 'loc0' }] : []),
        ...(v0.blankCharacter !== undefined
          ? [{ kind: 'character', id: '' }]
          : []),
      ],
    })),
  }
}

/** v0 夹具组装（评审第七轮拆分）：首节点恒为 branch（选项 id 确定性
 * 唯一化）；场景 id 确定性唯一化（s0..——空白/重复 id 会触发重发，按
 * 原始 id 对准的预期就会失配）；边/对白分镜/设定的组装委托给各聚焦
 * helper。 */
function assembleV0Doc(v0: ArbValue<typeof v0EnvelopeArb>): {
  doc: Record<string, unknown>
  flowEdges: Array<Record<string, unknown>>
  branchEdges: Array<Record<string, unknown>>
  optionCount: number
} {
  const branchNode = {
    id: 'br0',
    type: 'branch',
    position: { x: 0, y: 0 },
    data: {
      prompt: v0.branch.prompt,
      options: v0.branch.optionLabels.map((label, i) => ({
        id: `opt${i}`,
        label,
      })),
    },
  }
  const docNodes = [
    branchNode,
    ...v0.scenes.map((sc, i) => ({ ...sc, id: `s${i}` })),
  ]
  const { flowEdges, branchEdges } = assembleV0Edges(v0, docNodes)
  const doc = {
    schemaVersion: 0,
    project: {
      id: 'p-old',
      name: '旧剧',
      createdAt: '',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    graph: {
      nodes: [...docNodes, ...assembleV0ListNodes(v0)],
      edges: [...flowEdges, ...branchEdges],
    },
    settings: assembleV0Settings(v0),
    episodeTitles: {},
    // a0 供分镜 assetId 引用位（空资产桶会让引用成为悬空脏数据）
    assets: {
      byId: {
        a0: {
          id: 'a0',
          relPath: 'assets/f0.png',
          mime: 'image/png',
          source: 'upload',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      },
    },
  }
  return {
    doc,
    flowEdges,
    branchEdges,
    optionCount: v0.branch.optionLabels.length,
  }
}

/** v0 迁移的边保全断言：合法剧情流边全部存活；在界下标句柄精确改写为
 * option-opt<N>（确定性唯一选项 id，无重发改写）、越界句柄隔离、同元组
 * 逻辑重复首见胜。键为 `${id}:${tuple}`（评审第十四轮：只比元组会放行
 * 「重发全部合法旧边 id」的迁移回归，稳定 id 是后续选择/删除/命令引用
 * 的锚点），预期与实际均按元组去重首见胜。 */
function assertV0EdgeMigration(
  content: ProjectContent,
  flowEdges: Array<Record<string, unknown>>,
  branchEdges: Array<Record<string, unknown>>,
  optionCount: number,
): void {
  const firstFlowByTuple = new Map<string, string>()
  for (const e of flowEdges) {
    const tuple = `${e.source}→${e.target}`
    if (!firstFlowByTuple.has(tuple))
      firstFlowByTuple.set(tuple, `${e.id}:${tuple}`)
  }
  const outFlowKeys = content.edges
    .filter((e) => edgeKindOf(e) === 'sequence')
    .map((e) => `${e.id}:${e.source}→${e.target}`)
  expect(outFlowKeys.sort(), '合法 v0 剧情流边全部存活（稳定 id）').toEqual(
    [...firstFlowByTuple.values()].sort(),
  )
  const firstBranchByTuple = new Map<string, string>()
  for (const e of branchEdges) {
    const idx = Number(String(e.sourceHandle ?? '').slice('option-'.length))
    if (idx >= optionCount) continue
    const tuple = `${e.target}→option-opt${idx}`
    if (!firstBranchByTuple.has(tuple))
      firstBranchByTuple.set(tuple, `${e.id}:${tuple}`)
  }
  const outBranchKeys = content.edges
    .filter((e) => edgeKindOf(e) === 'branch' && e.source === 'br0')
    .map((e) => `${e.id}:${e.target}→${e.sourceHandle}`)
  expect(
    outBranchKeys.sort(),
    '在界下标句柄精确迁移并全部幸存（稳定 id）',
  ).toEqual([...firstBranchByTuple.values()].sort())
}

/** v0 迁移的节点载荷比对（评审第十一轮）：迁移把合法 v0 载荷换成空/默认
 * 值的回归此前不可见（输出不变量只管身份与图结构，边断言只管边）。分支
 * 提示词/选项与场景名称/内外景/简介逐字存活；sceneNo 非法时按 §4.2 顺位
 * 重发（文档序最小未占用正整数），预期按同一规则在夹具上现算。 */
function assertV0NodePayloads(
  content: ProjectContent,
  v0: ArbValue<typeof v0EnvelopeArb>,
): void {
  const branch = content.nodes.find((n) => n.id === 'br0')
  expect(branch?.type, 'v0 分支节点存活').toBe('branch')
  if (branch?.type === 'branch') {
    expect(branch.data.prompt, 'v0 分支提示词保全').toBe(v0.branch.prompt)
    expect(branch.data.options, 'v0 分支选项载荷保全').toEqual(
      v0.branch.optionLabels.map((label, i) => ({ id: `opt${i}`, label })),
    )
  }
  // sceneNo 顺位重发预期：合法编号（正安全整数）保留并占位（含重复），
  // 非法编号按文档序取最小未占用正整数（与 renumberSeqFields 同一规则）
  const used = new Set<number>()
  const expectedSceneNos = v0.scenes.map((sc) => {
    const cur = sc.data.sceneNo
    if (Number.isSafeInteger(cur) && cur > 0) {
      used.add(cur)
      return cur
    }
    let next = 1
    while (used.has(next)) next += 1
    used.add(next)
    return next
  })
  v0.scenes.forEach((sc, i) => {
    const scene = content.nodes.find((n) => n.id === `s${i}`)
    expect(scene?.type, `v0 场景 s${i} 存活`).toBe('scene')
    if (scene?.type !== 'scene') return
    expect(scene.data.name, `v0 场景 s${i} 名称保全`).toBe(sc.data.name)
    expect(scene.data.sceneNo, `v0 场景 s${i} 编号保全/顺位重发`).toBe(
      expectedSceneNos[i],
    )
    expect(scene.data.interior, `v0 场景 s${i} 内外景保全`).toBe(
      sc.data.interior,
    )
    expect(scene.data.synopsis, `v0 场景 s${i} 简介保全`).toBe(sc.data.synopsis)
  })
}

/** v0 迁移的对白/分镜载荷比对（评审第十二轮）：台词行身份/类型/文本/
 * 说话人逐行有序存活——对象 speaker（头像标签）经 ensureCharacter 解析为
 * 首个同名角色的 id（角色 gradient 全 'g'，精确匹配首见胜），字符串直引
 * 原样存活；分镜引用位的 id/kind/assetId 或 label 存活、不被重发。 */
function assertV0ListNodePayloads(
  content: ProjectContent,
  v0: ArbValue<typeof v0EnvelopeArb>,
): void {
  v0.dialogues.forEach((d, i) => {
    const node = content.nodes.find((n) => n.id === `dl${i}`)
    expect(node?.type, `v0 对白 dl${i} 存活`).toBe('dialogue')
    if (node?.type !== 'dialogue') return
    expect(node.data.name, `v0 对白 dl${i} 名称保全`).toBe(d.name)
    const expectedLines = d.lines.map((l, j) => {
      const speaker =
        l.speaker === 'object'
          ? `ch${v0.characterNames.indexOf(
              v0.characterNames[l.speakerNameIdx % v0.characterNames.length],
            )}`
          : l.speaker === 'string'
            ? 'ch0'
            : ''
      return `dl${i}-${j}:line:${l.text}:${speaker}`
    })
    expect(
      node.data.lines.map(
        (l) => `${l.id}:${l.kind}:${l.text}:${l.speaker ?? ''}`,
      ),
      `v0 对白 dl${i} 台词行逐行保全（对象 speaker 解析到首见同名角色）`,
    ).toEqual(expectedLines)
  })
  v0.shots.forEach((s, i) => {
    const node = content.nodes.find((n) => n.id === `sh${i}`)
    expect(node?.type, `v0 分镜 sh${i} 存活`).toBe('shot')
    if (node?.type !== 'shot') return
    expect(node.data.shotNo, `v0 分镜 sh${i} 编号保全`).toBe(i + 1)
    expect(node.data.picture, `v0 分镜 sh${i} 画面保全`).toBe(s.picture)
    expect(
      node.data.refs.map(
        (r) => `${r.id}:${r.kind}:${'assetId' in r ? r.assetId : r.label}`,
      ),
      `v0 分镜 sh${i} 引用位保全（id 不被重发）`,
    ).toEqual([
      s.withAssetRef ? `sr${i}:character:a0` : `sr${i}:audio:${s.picture}`,
    ])
  })
}

/** v0 迁移的设定桶比对（评审第十六轮改为全记录）：干净角色（含
 * gradient）/地点/道具/文档（含 body 与完整 relatedIds）逐条与夹具记录
 * deep-equal——只比 id+名称投影会放行 gradient/body 被清空；空白 id 角色
 * 的重发身份单独断言（新 id 不可预测，比 name+gradient），其被文档
 * relatedIds 引用的改写值以「干净 id 集合外的重发 id」嵌入全记录预期。 */
function assertV0SettingsMigration(
  content: ProjectContent,
  v0: ArbValue<typeof v0EnvelopeArb>,
): void {
  const cleanCharIds = new Set(v0.characterNames.map((_, i) => `ch${i}`))
  const charsOut = content.settings.characters
  expect(
    charsOut.filter((c) => cleanCharIds.has(c.id)),
    'v0 角色全记录迁移存活（含 gradient）',
  ).toEqual(
    v0.characterNames.map((name, i) => ({ id: `ch${i}`, name, gradient: 'g' })),
  )
  const extras = charsOut.filter((c) => !cleanCharIds.has(c.id))
  expect(
    extras.map((c) => ({ name: c.name, gradient: c.gradient })),
    'v0 空白 id 角色数组期重发（恰增一件，不塌缩不丢件，gradient 保全）',
  ).toEqual(
    v0.blankCharacter !== undefined
      ? [{ name: v0.blankCharacter, gradient: 'g' }]
      : [],
  )
  expect(content.settings.locations, 'v0 地点全记录迁移存活').toEqual(
    v0.locationNames.map((name, i) => ({ id: `loc${i}`, name })),
  )
  expect(content.settings.props ?? [], 'v0 道具全记录迁移存活').toEqual(
    v0.propNames.map((name, i) => ({ id: `prop${i}`, name })),
  )
  const reissuedId = extras[0]?.id
  expect(
    content.settings.documents ?? [],
    'v0 文档全记录迁移存活（含 body，relatedIds 空白引用随重发改写）',
  ).toEqual(
    v0.documentSpecs.map((d, i) => ({
      id: `doc${i}`,
      title: d.title,
      body: '正文',
      relatedIds: [
        { kind: 'character', id: 'ch0' },
        ...(d.withLocation ? [{ kind: 'location', id: 'loc0' }] : []),
        ...(v0.blankCharacter !== undefined
          ? [{ kind: 'character', id: reissuedId }]
          : []),
      ],
    })),
  )
}

describe('归一化不变量的生成式验证（issue #232）：v0 迁移与拒绝边界', () => {
  it('任意 v0 信封：迁移成功、输出满足不变量、迁移产物幂等', () => {
    fc.assert(
      fc.property(v0EnvelopeArb, (v0) => {
        const { doc, flowEdges, branchEdges, optionCount } = assembleV0Doc(v0)
        const migrated = parseProject(doc)
        expect(migrated.migrated).toBe(true)
        // 设定四桶迁移存活（评审第八轮角色起，第十二轮补齐地点/道具/文档
        // 与空白 id 重发的 relatedIds 改写）
        assertV0SettingsMigration(migrated.content, v0)
        assertOutputInvariants(migrated.content)
        assertV0NodePayloads(migrated.content, v0)
        assertV0ListNodePayloads(migrated.content, v0)
        assertV0EdgeMigration(
          migrated.content,
          flowEdges,
          branchEdges,
          optionCount,
        )
        const round2 = parseProject(
          serializeProject(migrated.content, PROJECT_ID, NOW),
        )
        expect(round2.migrated).toBe(false)
        expect(round2.repaired).toBe(false)
      }),
    )
  })
  it('允许拒绝的版本边界：过新版本显式拒绝，非法版本按损坏拒绝', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: CURRENT_SCHEMA_VERSION + 1, max: 99 }),
        fc.constantFrom(null, -1, 1.5, '1', Number.NaN, true),
        (tooNew, garbage) => {
          expect(() => parseProject({ schemaVersion: tooNew })).toThrow(
            /版本过新/,
          )
          expect(() => parseProject({ schemaVersion: garbage })).toThrow(
            TypeError,
          )
        },
      ),
    )
    expect(() => parseProject('oops')).toThrow(/损坏/)
    expect(() => parseProject(null)).toThrow(/损坏/)
  })
})
