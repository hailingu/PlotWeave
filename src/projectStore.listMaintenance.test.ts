import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseProject } from './model/convert'

/**
 * projectStore Tauri 路径的列表维护写（issue #134 及 PR #196/#198 评审）：
 * 空库播种与已知示例升级回写同用户保存/删除/重试登记的交错时序——维护写
 * 必须经项目保存链（统一排序、失败登记、删除墓碑、在途定序），不以旧
 * 内容覆盖较新内容、不清除更新的重试登记、不复活已删对象。mock IPC
 * harness 与 projectStore.tauri.test.ts 同款；自该文件拆出（PR #198
 * 评审：源文件已达 1800 行测试上限）。
 */

const handlers = new Map<string, (args: unknown) => unknown>()
const calls: Array<{ cmd: string; args: unknown }> = []

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
  handlers.clear()
  calls.length = 0
  // tauriLoad 固定先做加载侧资产复验：默认无不可验证键，专项用例自行覆盖
  handlers.set('verify_project_assets', () => [])
  // duplicate 命名先查现存名（§7.3）：默认返回非空列表——空表会触发
  // tauriList 的空库播种递归，mock 恒空即无限循环
  handlers.set('list_projects', () => [meta('p1')])
  vi.doMock('@tauri-apps/api/core', () => ({
    invoke: async (cmd: string, args: unknown) => {
      calls.push({ cmd, args })
      const h = handlers.get(cmd)
      if (!h) throw new Error(`未编排的命令：${cmd}`)
      return h(args)
    },
  }))
})

const load = async (): Promise<typeof import('./projectStore')> =>
  import('./projectStore')

const UPDATED_ISO = new Date(1_700_000_000_000).toISOString()

const meta = (id: string) => ({
  id,
  name: id,
  updated_at: UPDATED_ISO,
  scene_count: 3,
  ending_count: 2,
})

/** v1 信封：四分区节点 + Record 设定集。 */
const modernFile = () => ({
  schemaVersion: 1,
  project: {
    id: 'p1',
    name: '现代剧',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: UPDATED_ISO,
  },
  graph: {
    nodes: [
      {
        id: 's1',
        type: 'scene',
        layout: { position: { x: 0, y: 0 } },
        ui: { selected: false, expanded: true },
        data: {
          spec: {
            sceneNo: 1,
            interior: true,
            time: '🌙 夜',
            synopsis: '',
            characterIds: [],
          },
          meta: { label: '场一' },
        },
      },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  },
  settings: { characters: {}, locations: {}, props: {}, documents: {} },
  episodeTitles: {},
  assets: { byId: {} },
})

/** v0 信封：旧扁平格式的节点字段（头像对象、地点字符串）经 Rust 包装。 */
const legacyFile = () => ({
  schemaVersion: 0,
  project: { id: 'p1', name: '旧剧', createdAt: '', updatedAt: UPDATED_ISO },
  graph: {
    nodes: [
      {
        id: 's1',
        type: 'scene',
        position: { x: 0, y: 0 },
        data: {
          name: '场一',
          sceneNo: 1,
          interior: true,
          time: '🌙 夜',
          synopsis: '',
          characters: [{ label: '林', gradient: 'g' }],
          location: '天台',
        },
      },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  },
  settings: { characters: [], locations: [] },
  episodeTitles: {},
  assets: { byId: {} },
})

/** issue #134/PR #198 评审共用夹具：列表维护写（示例升级回写/空库播种）
 * 与用户保存/删除/重试登记的交错栅栏——维护写必须经保存链（统一排序、
 * 失败登记、删除墓碑），迟到修复不得覆盖较新内容、清除更新的重试登记
 * 或复活已删对象。 */
const SID = 'sample-wu-ye-chu-zu-che'
const legacyOf = () => ({
  ...legacyFile(),
  project: { ...legacyFile().project, id: SID },
})
const cleanOf = () => ({
  ...modernFile(),
  project: { ...modernFile().project, id: SID },
})
const userDocOf = (id: string) =>
  parseProject(
    {
      ...modernFile(),
      project: { ...modernFile().project, id, name: '用户编辑' },
    },
    { projectId: id },
  ).content
/** 一次性栅栏：首次调用挂起至放行并返回待迁移旧格式；此后返回迁移
 * 净本——旧实现回写后重列的升级检查读到净本，不再触发写也不再挂起。 */
const gatedThenCleanLoad = (gate: { fn: (() => void) | null }) => {
  let gated = true
  return () => {
    if (!gated) return cleanOf()
    gated = false
    return new Promise<unknown>((res) => {
      gate.fn = () => res(legacyOf())
    })
  }
}
const savesOf = (id: string) =>
  calls.filter(
    (c) => c.cmd === 'save_project' && (c.args as { id: string }).id === id,
  )

describe('tauriList 维护写：升级窗口与保存链交错（issue #134）', () => {
  it('升级窗口内排入新保存：迟到修复跳过回写，不覆盖较新内容（issue #134）', async () => {
    const gate = { fn: null as (() => void) | null }
    handlers.set('list_projects', () => [meta(SID)])
    handlers.set('load_project', gatedThenCleanLoad(gate))
    handlers.set('save_project', () => undefined)
    const { projectStore } = await load()
    const listing = projectStore.list()
    await vi.waitFor(() =>
      expect(calls.filter((c) => c.cmd === 'load_project')).toHaveLength(1),
    )
    const saving = projectStore.save(SID, userDocOf(SID))
    await vi.waitFor(() =>
      expect(calls.some((c) => c.cmd === 'save_project')).toBeTruthy(),
    )
    gate.fn!()
    await Promise.all([listing, saving])
    const saves = calls.filter((c) => c.cmd === 'save_project')
    // 红（旧实现）：迁移回写作为第二个 save_project 落盘，旧内容覆盖用户编辑
    expect(saves).toHaveLength(1)
    expect(
      (saves[0].args as { doc: { project: { name: string } } }).doc.project
        .name,
    ).toBe('用户编辑')
  })

  it('升级窗口内删除示例：迟到修复跳过回写，不复活已删对象（issue #134）', async () => {
    const gate = { fn: null as (() => void) | null }
    handlers.set('list_projects', () => [meta(SID)])
    handlers.set('load_project', gatedThenCleanLoad(gate))
    handlers.set('save_project', () => undefined)
    handlers.set('delete_project', () => undefined)
    handlers.set('delete_ai_session', () => undefined)
    const { projectStore } = await load()
    const listing = projectStore.list()
    await vi.waitFor(() =>
      expect(calls.filter((c) => c.cmd === 'load_project')).toHaveLength(1),
    )
    const deleting = projectStore.delete(SID)
    await vi.waitFor(() =>
      expect(calls.some((c) => c.cmd === 'delete_project')).toBeTruthy(),
    )
    gate.fn!()
    await Promise.all([listing, deleting])
    // 红（旧实现）：直连 tauriSave 在删除排队后落盘——重建 JSON 复活已删项目
    expect(calls.filter((c) => c.cmd === 'save_project')).toHaveLength(0)
  })

  it('示例有在途保存时升级检查先等链落定再读盘（issue #134）', async () => {
    let releaseSave: (() => void) | null = null
    handlers.set('list_projects', () => [meta(SID)])
    handlers.set(
      'save_project',
      () =>
        new Promise((res) => {
          releaseSave = () => res(undefined)
        }),
    )
    handlers.set('load_project', () => cleanOf())
    const { projectStore } = await load()
    const saving = projectStore.save(SID, userDocOf(SID))
    await vi.waitFor(() => expect(releaseSave).not.toBeNull())
    const listing = projectStore.list()
    await new Promise((r) => setTimeout(r, 10))
    // 红（旧实现）：不等链静止即读盘——读到保存前的旧内容，随后的修复
    // 回写以旧内容参与排序竞争
    expect(calls.filter((c) => c.cmd === 'load_project')).toHaveLength(0)
    releaseSave!()
    await Promise.all([saving, listing])
    expect(calls.filter((c) => c.cmd === 'load_project')).toHaveLength(1)
  })
})

describe('tauriList 维护写：成功维护写不得清除更新的重试登记（PR #198 评审）', () => {
  it('示例存在待重试的失败保存：升级跳过回写，最新登记不被成功维护写清除（PR #198 评审）', async () => {
    let loadCalls = 0
    handlers.set('list_projects', () => [meta(SID)])
    handlers.set('load_project', () => {
      loadCalls += 1
      return loadCalls === 1 ? legacyOf() : cleanOf()
    })
    let saveCalls = 0
    handlers.set('save_project', () => {
      saveCalls += 1
      if (saveCalls === 1) throw new Error('磁盘满')
      return undefined
    })
    const { projectStore } = await load()
    // 用户保存失败：最新编辑登记为待重试（比磁盘新）
    await projectStore.save(SID, userDocOf(SID)).catch(() => undefined)
    const { pendingRetryDocOf } = await import('./projectStore/saveChain')
    expect(pendingRetryDocOf(SID)?.name).toBe('用户编辑')
    const list = await projectStore.list()
    // 红（旧实现）：升级以旧盘内容成功回写，成功保存按契约清除登记——
    // 用户最新编辑被永久丢弃（saveCalls 变 2、登记消失）
    expect(saveCalls).toBe(1)
    expect(pendingRetryDocOf(SID)?.name).toBe('用户编辑')
    expect(list.map((x) => x.id)).toEqual([SID])
  })

  it('播种目标存在待重试的失败保存：跳过种子写，登记保持（PR #198 评审）', async () => {
    const saved = new Set<string>()
    let saveCalls = 0
    handlers.set('list_projects', () =>
      saved.size > 0 ? [meta('sample-du-shi-qi-yuan')] : [],
    )
    handlers.set('load_project', (args) =>
      Promise.reject(new Error(`项目不存在：${(args as { id: string }).id}`)),
    )
    handlers.set('save_project', (args) => {
      saveCalls += 1
      if (saveCalls === 1) throw new Error('磁盘满')
      saved.add((args as { id: string }).id)
      return undefined
    })
    const { projectStore } = await load()
    // 示例文件已丢失且其用户保存失败：最新编辑登记重试（比磁盘/空目录新）
    await projectStore.save(SID, userDocOf(SID)).catch(() => undefined)
    const { pendingRetryDocOf } = await import('./projectStore/saveChain')
    expect(pendingRetryDocOf(SID)?.name).toBe('用户编辑')
    const list = await projectStore.list()
    // 红（旧实现）：种子写在登记之后成功落盘并清除登记——用户编辑被
    // 永久丢弃；修复后种子跳过（留待链重试重建文件），另一示例正常播种
    expect(savesOf(SID)).toHaveLength(1)
    expect(pendingRetryDocOf(SID)?.name).toBe('用户编辑')
    expect(savesOf('sample-du-shi-qi-yuan').length).toBeGreaterThan(0)
    expect(list.map((x) => x.id)).toEqual(['sample-du-shi-qi-yuan'])
  })
})

describe('tauriList 维护写：播种与在途保存定序（PR #198 评审）', () => {
  it('播种开始前该示例已有在途保存：等链落定再探测，保存落盘后自然跳过（PR #198 评审）', async () => {
    const DSID = 'sample-du-shi-qi-yuan'
    let releaseSave: (() => void) | null = null
    let saveCalls = 0
    const saved = new Set<string>()
    handlers.set('list_projects', () => (saved.size > 0 ? [meta(DSID)] : []))
    handlers.set('save_project', (args) => {
      const { id } = args as { id: string }
      if (saveCalls === 0) {
        saveCalls += 1
        return new Promise((res) => {
          releaseSave = () => {
            saved.add(id)
            res(undefined)
          }
        })
      }
      saved.add(id)
      return undefined
    })
    handlers.set('load_project', (args) => {
      const { id } = args as { id: string }
      // 保存落盘前探测会 not-found（在途）；落盘后应读到「已存在」
      if (id === DSID && saved.has(DSID)) {
        return Promise.resolve({
          ...modernFile(),
          project: { ...modernFile().project, id },
        })
      }
      return Promise.reject(new Error(`项目不存在：${id}`))
    })
    const { projectStore } = await load()
    // 用户保存先行在途（慢盘）；空库列表随后启动播种
    const saving = projectStore.save(DSID, userDocOf(DSID))
    await vi.waitFor(() => expect(savesOf(DSID).length).toBeGreaterThan(0))
    const listing = projectStore.list()
    // 留出旧实现「不等链」探测的时序窗（新实现阻塞在等链落定，不受影响）
    await new Promise((r) => setTimeout(r, 20))
    releaseSave!()
    await Promise.all([saving, listing])
    // 红（旧实现）：不等链落定即探测 not-found，链身份未变守卫放行，
    // 种子排在用户保存之后落盘——硬编码内容覆盖用户写入
    const dsidSaves = savesOf(DSID)
    expect(dsidSaves).toHaveLength(1)
    expect(
      (dsidSaves[0].args as { doc: { project: { name: string } } }).doc.project
        .name,
    ).toBe('用户编辑')
  })
})

describe('tauriList 维护写：播种不覆盖既有内容（issue #134）', () => {
  it('播种探测窗口内示例删除在途：种子写被墓碑吸收，已删示例零落盘（issue #134）', async () => {
    let releaseProbe: (() => void) | null = null
    let releaseDelete: (() => void) | null = null
    let probed = false
    handlers.set('list_projects', () =>
      calls.some((c) => c.cmd === 'save_project')
        ? [meta('sample-du-shi-qi-yuan')]
        : [],
    )
    handlers.set('load_project', () => {
      if (!probed) {
        probed = true
        return new Promise((_res, rej) => {
          releaseProbe = () => rej(new Error('项目不存在：'))
        })
      }
      return Promise.reject(new Error('项目不存在'))
    })
    handlers.set(
      'delete_project',
      () =>
        new Promise((res) => {
          releaseDelete = () => res(undefined)
        }),
    )
    handlers.set('delete_ai_session', () => undefined)
    handlers.set('save_project', () => undefined)
    const { projectStore } = await load()
    const listing = projectStore.list()
    await vi.waitFor(() => expect(releaseProbe).not.toBeNull())
    const deleting = projectStore.delete(SID)
    await vi.waitFor(() => expect(releaseDelete).not.toBeNull())
    releaseProbe!()
    await listing
    releaseDelete!()
    await deleting
    // 红（旧实现）：直连 tauriSave 在墓碑期落盘该示例；链路径被墓碑吸收，
    // 已删示例零落盘（另一示例 not-found 确证后正常播种）
    expect(savesOf(SID)).toHaveLength(0)
    expect(savesOf('sample-du-shi-qi-yuan').length).toBeGreaterThan(0)
  })

  it('播种探测窗口内目标排入新写入：跳过种子写，不以硬编码种子覆盖（issue #134）', async () => {
    const DSID = 'sample-du-shi-qi-yuan'
    let releaseProbe: (() => void) | null = null
    let probed = false
    handlers.set('list_projects', () =>
      calls.some((c) => c.cmd === 'save_project') ? [meta(DSID)] : [],
    )
    handlers.set('load_project', (args) => {
      if ((args as { id: string }).id === DSID && !probed) {
        probed = true
        return new Promise((_res, rej) => {
          releaseProbe = () => rej(new Error('项目不存在：'))
        })
      }
      return Promise.reject(new Error('项目不存在'))
    })
    handlers.set('save_project', () => undefined)
    const { projectStore } = await load()
    const listing = projectStore.list()
    await vi.waitFor(() => expect(releaseProbe).not.toBeNull())
    // 窗口内该示例排入新保存（如链重试/编辑器补写）：探测结果已过时
    const saving = projectStore.save(DSID, userDocOf(DSID))
    await vi.waitFor(() => expect(savesOf(DSID).length).toBeGreaterThan(0))
    releaseProbe!()
    await Promise.all([listing, saving])
    // 红（旧实现）：种子排在窗口内写入之后落盘，硬编码内容覆盖用户写入
    const dsidSaves = savesOf(DSID)
    expect(dsidSaves).toHaveLength(1)
    expect(
      (dsidSaves[0].args as { doc: { project: { name: string } } }).doc.project
        .name,
    ).toBe('用户编辑')
  })
})
