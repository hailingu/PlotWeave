import { describe, expect, it } from 'vitest'
import { extractBatchJson, validateAiBatch, type AiGraphSnapshot } from './commands'
import { wouldCreateCycle } from '../graphRules'

/** 测试用快照：节拍 n2 → 场景 n1 的两节点剧情流（无资产）。 */
function snap(): AiGraphSnapshot {
  return {
    nodes: [
      { id: 'n1', type: 'scene', label: '场 01 · 天台' },
      { id: 'n2', type: 'beat', label: '节拍 · 开端' },
    ],
    edges: [{ source: 'n2', target: 'n1' }],
    assets: new Map(),
  }
}

/** 测试用快照：场景 s1 下挂分镜 sh1，分支 b1（两个选项）；含 image/audio 资产。 */
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
    assets: new Map([
      ['a-img', 'image/png'],
      ['a-aud', 'audio/mpeg'],
    ]),
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
      assets: new Map(),
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

  it('update_node 的字符串选项按位置复用既有稳定 id：重命名不清空引出连线', () => {
    // 红：字符串形态整体重发新 id——全部既有 option- 句柄被视为已删选项，
    // 折叠/模拟静默清除每条引出线，而预览只显示一次普通选项更新
    const v = validateAiBatch(
      [{ op: 'update_node', nodeId: 'b1', patch: { options: ['追！', '不追'] } }],
      richSnap(),
    )
    expect(v.ok).toBe(true)
    const patch = (v.commands[0] as unknown as {
      patch: { options: Array<{ id: string; label: string }> }
    }).patch
    expect(patch.options).toEqual([
      { id: 'ob-a', label: '追！' },
      { id: 'ob-b', label: '不追' },
    ])
    // 超出现有选项数的字符串仍是新增（发新 id）
    const grown = validateAiBatch(
      [{ op: 'update_node', nodeId: 'b1', patch: { options: ['追！', '不追', '再想想'] } }],
      richSnap(),
    )
    const grownOptions = (grown.commands[0] as unknown as {
      patch: { options: Array<{ id: string }> }
    }).patch.options
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
