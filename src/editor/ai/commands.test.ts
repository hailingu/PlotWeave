import { describe, expect, it } from 'vitest'
import { extractBatchJson, validateAiBatch, type AiGraphSnapshot } from './commands'
import { wouldCreateCycle } from '../graphRules'

/** 测试用快照：节拍 n2 → 场景 n1 的两节点剧情流。 */
function snap(): AiGraphSnapshot {
  return {
    nodes: [
      { id: 'n1', type: 'scene', label: '场 01 · 天台' },
      { id: 'n2', type: 'beat', label: '节拍 · 开端' },
    ],
    edges: [{ source: 'n2', target: 'n1' }],
  }
}

/** 测试用快照：场景 s1 下挂分镜 sh1，分支 b1（两个选项）。 */
function richSnap(): AiGraphSnapshot {
  return {
    nodes: [
      { id: 's1', type: 'scene', label: '场 01 · 天台' },
      { id: 'sh1', type: 'shot', label: 'SHOT01·中景' },
      {
        id: 'b1',
        type: 'branch',
        label: '分支 · 追或不追？',
        options: [
          { id: 'ob-a', label: '追' },
          { id: 'ob-b', label: '不追' },
        ],
      },
    ],
    edges: [],
  }
}

describe('extractBatchJson', () => {
  it('从散文与 json 围栏中取最后一个批次', () => {
    const text = '先解释……\n```json\n{"commands":[{"op":"create_node","nodeType":"beat"}]}\n```\n再补充一句。'
    const parsed = extractBatchJson(text)
    expect(parsed).toEqual({ commands: [{ op: 'create_node', nodeType: 'beat' }] })
  })
  it('无围栏时直接识别裸批次对象', () => {
    expect(extractBatchJson('{"commands":[]}')).toEqual({ commands: [] })
  })
  it('没有可解析的批次返回 undefined', () => {
    expect(extractBatchJson('纯文本回复，不改动画布')).toBeUndefined()
    expect(extractBatchJson('```json\nnot-json\n```')).toBeUndefined()
  })
  it('多个围栏只取最后一个；最后一个非法时不回退到前面的合法围栏', () => {
    expect(extractBatchJson('```json\nnot-json\n```\n```json\n{"commands":[]}\n```')).toEqual({
      commands: [],
    })
    expect(extractBatchJson('```json\n{"commands":[]}\n```\n```json\nnot-json\n```')).toBeUndefined()
  })
  it('围栏标记大小写不敏感（```JSON 亦可）', () => {
    expect(extractBatchJson('```JSON\n{"commands":[]}\n```')).toEqual({ commands: [] })
  })
  it('非 json 围栏（如 ```ts）不参与提取', () => {
    expect(extractBatchJson('```ts\nconst x = 1\n```\n```json\n{"commands":[]}\n```')).toEqual({
      commands: [],
    })
  })
  it('未闭合的围栏不产出候选；裸批次须为完整文本，混入围栏杂讯则拒绝', () => {
    expect(extractBatchJson('```json\n{"commands":[]}')).toBeUndefined()
    expect(extractBatchJson('{"commands":[]}\n```json\nnot-closed')).toBeUndefined()
  })
})

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
    }
    const v = validateAiBatch(
      [{ op: 'update_node', nodeId: 'd9', patch: { lines: [{ kind: 'action', text: '沉默' }] } }],
      s,
    )
    expect(v.ok).toBe(true)
    const cmd = v.commands[0] as unknown as { patch: { lines: Array<{ id: string }> } }
    expect(cmd.patch.lines[0].id).toMatch(/^line-/)
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
    expect(new Set(lineIds).size).toBe(4) // 全唯一
    expect(lineIds.every((id) => id !== '')).toBe(true)
    expect(lineIds[0]).toBe('dup') // 首个保留
    expect(lineIds[1]).toMatch(/^line-/) // 冲突重生成
    expect(lineIds[2]).toMatch(/^line-/) // 空串重生成
    expect(lineIds[3]).toBe('solo') // 无冲突原样

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
    // n1 是 scene：合法
    expect(bad.ok).toBe(true)

    const shotBad = validateAiBatch(
      [{ op: 'update_node', nodeId: 'x', patch: { episodeNo: 1 } }],
      { ...snap(), nodes: [...snap().nodes, { id: 'x', type: 'shot', label: 'SHOT01' }] },
    )
    expect(shotBad.ok).toBe(false)
    expect(shotBad.issues[0].message).toContain('分镜')
  })
})

describe('分类型连线校验（剧情流 / 分支选项出口 / 分镜下挂）', () => {
  it('默认 sequence：普通节点间连线合法', () => {
    const v = validateAiBatch([{ op: 'connect_edge', sourceId: 'b1', targetId: 's1' }], richSnap())
    expect(v.ok).toBe(true)
    expect(v.commands[0]).toMatchObject({ edgeKind: 'sequence' })
  })

  it('attach 仅允许 场景 → 分镜（下挂），且不做环检测', () => {
    const ok = validateAiBatch(
      [
        { op: 'connect_edge', sourceId: 's1', targetId: 'sh1', edgeKind: 'attach' },
        { op: 'connect_edge', sourceId: 'sh1', targetId: 's1', edgeKind: 'sequence' }, // 反向不成环
      ],
      richSnap(),
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

  it('同对节点的 sequence 与 attach 视为不同端口，不判重复', () => {
    const v = validateAiBatch(
      [
        { op: 'connect_edge', sourceId: 's1', targetId: 'sh1', edgeKind: 'sequence' },
        { op: 'connect_edge', sourceId: 's1', targetId: 'sh1', edgeKind: 'attach' },
      ],
      richSnap(),
    )
    expect(v.ok).toBe(true)
  })
})
