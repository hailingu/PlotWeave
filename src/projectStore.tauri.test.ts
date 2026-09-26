import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectContent } from './projectStore'

/** projectStore 的 Tauri 路径：mock IPC，isTauri 判真后动态 import。
 * invoke 按命令名路由，行为由各用例编排。
 * load_project 返回的是 ProjectDocument 信封（Rust 侧已把旧扁平格式包装为 v0）。 */

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

describe('tauriLoad：归一化与迁移回写', () => {
  it('episodeTitles 只保留「正整数键 → 非空标题」，标题去空白', async () => {
    handlers.set('load_project', () => ({
      ...modernFile(),
      episodeTitles: {
        1: ' 开局 ',
        2: '   ',
        x: 'y',
        0: '零',
        '-1': '负',
        '3.5': '小数',
        4: 7,
      },
    }))
    handlers.set('save_project', () => undefined)
    const { projectStore } = await load()
    const doc = await projectStore.load('p1')
    expect(doc.episodeTitles).toEqual({ 1: '开局' })
    // 修复型归一化（键值域修复）同样回写落定；加载侧资产复验固定先行
    expect(calls.map((c) => c.cmd)).toEqual([
      'load_project',
      'verify_project_assets',
      'save_project',
    ])
  })

  it('加载等待在途保存链落定：关闭后立即重开不读旧盘（编辑不基于旧内容反向覆盖新冲刷）', async () => {
    let releaseSave: (() => void) | null = null
    handlers.set('load_project', () => modernFile())
    handlers.set('verify_project_assets', () => [])
    handlers.set(
      'save_project',
      () =>
        new Promise<void>((resolve) => {
          releaseSave = resolve
        }),
    )
    const { projectStore } = await load()
    const docOf = (name: string) => ({
      name,
      nodes: [],
      edges: [],
      settings: { characters: [], locations: [] },
    })
    // 用户编辑 v2 后立即离开编辑器：卸载冲刷挂起（慢盘）
    const saving = projectStore.save('p1', docOf('v2'))
    await vi.waitFor(() => expect(releaseSave).not.toBeNull())
    // 冲刷未落盘时立即重开：load 不得先于冲刷完成返回（否则读到旧盘内容，
    // 随后编辑把旧文档重新排队落盘，覆盖刚冲刷的新编辑）
    const loading = projectStore.load('p1')
    let resolved = false
    void loading.then(() => {
      resolved = true
    })
    await Promise.resolve()
    expect(resolved).toBe(false)
    ;(releaseSave as unknown as () => void)()
    await saving
    const doc = await loading
    expect(doc.name).toBe('现代剧')
  })

  it('读取期间排队的保存失败登记：链守卫重启须回到登记复验段——交付登记文档而非更旧的磁盘内容', async () => {
    let loadCalls = 0
    const storeBox: { current?: typeof import('./projectStore') } = {}
    handlers.set('load_project', () => {
      loadCalls += 1
      if (loadCalls === 1) {
        // load_project 在途：卸载冲刷排队保存，且该保存落盘失败（登记为
        // 待重试——比磁盘新）
        void storeBox.current?.projectStore
          .save('p1', {
            name: '登记的最新',
            nodes: [],
            edges: [],
            settings: { characters: [], locations: [] },
          })
          .catch(() => undefined)
        return modernFile()
      }
      return {
        ...modernFile(),
        project: { ...modernFile().project, name: '重读的磁盘' },
      }
    })
    handlers.set('save_project', () => {
      throw new Error('磁盘满')
    })
    const mod = await load()
    storeBox.current = mod
    const doc = await mod.projectStore.load('p1')
    // 红：守卫只在磁盘读取段内 continue，不再回到登记复验段——重读磁盘
    // 并交付更旧内容，随后编辑会覆盖登记中的新改动
    expect(doc.name).toBe('登记的最新')
  })

  it('读取期间新保存排队：链身份守卫整体重来，修复回写不得晚于新保存覆盖新内容', async () => {
    let loadCalls = 0
    const storeBox: { current?: typeof import('./projectStore') } = {}
    handlers.set('load_project', () => {
      loadCalls += 1
      if (loadCalls === 1) {
        // load_project 在途：编辑器卸载冲刷把新保存排进链（此前链本静止）
        void storeBox.current?.projectStore
          .save('p1', {
            name: '冲刷的新编辑',
            nodes: [],
            edges: [],
            settings: { characters: [], locations: [] },
          })
          .catch(() => undefined)
        // 返回写前旧文件（脏 v1：空白边 id 触发修复回写）
        return {
          ...modernFile(),
          graph: {
            ...modernFile().graph,
            edges: [
              {
                id: '   ',
                source: 's1',
                target: 's1',
                data: { kind: 'sequence' },
              },
            ],
          },
        }
      }
      // 守卫触发重来的读取：写后净本，不再触发回写
      return {
        ...modernFile(),
        project: { ...modernFile().project, name: '写后净本' },
      }
    })
    handlers.set('save_project', () => undefined)
    const mod = await load()
    storeBox.current = mod
    const doc = await mod.projectStore.load('p1')
    // 旧内容的修复回写不得在冲刷之后落盘——重来后读到净本即无需回写
    const saves = calls.filter((c) => c.cmd === 'save_project')
    expect(
      saves.map(
        (s) =>
          (s.args as { doc: { project: { name: string } } }).doc.project.name,
      ),
    ).toEqual(['冲刷的新编辑'])
    expect(doc.name).toBe('写后净本')
  })

  it('加载等到保存链静止：A 在途期间 B 入队，读盘不得早于 B 落定', async () => {
    let releaseA: (() => void) | null = null
    let saveCalls = 0
    handlers.set('load_project', () => modernFile())
    handlers.set('verify_project_assets', () => [])
    handlers.set('save_project', () => {
      saveCalls += 1
      if (saveCalls === 1) {
        // A 挂起（慢盘）
        return new Promise<void>((resolve) => {
          releaseA = resolve
        })
      }
      return undefined // B 立即完成
    })
    const { projectStore } = await load()
    const docOf = (name: string) => ({
      name,
      nodes: [],
      edges: [],
      settings: { characters: [], locations: [] },
    })
    const savingA = projectStore.save('p1', docOf('A'))
    await vi.waitFor(() => expect(releaseA).not.toBeNull())
    // load 先捕获 A 的链（单次等待只能看到 A）
    const loading = projectStore.load('p1')
    await new Promise((r) => setTimeout(r, 0))
    // A 在途期间旧编辑器卸载冲刷把 B 排进链；随后 A 落定
    const savingB = projectStore.save('p1', docOf('B'))
    ;(releaseA as unknown as () => void)()
    await savingA
    await savingB
    await loading
    // 红：单次等待在 A 落定后立即读盘（B 尚未起跑）——读到的旧会话被编辑
    // 即覆盖 B；须循环等到链静止
    const order = calls.map((c) => c.cmd)
    expect(order.indexOf('load_project')).toBeGreaterThan(
      order.lastIndexOf('save_project'),
    )
  })

  it('加载优先交付失败登记的最新文档：磁盘滞后时不展示丢编辑的旧版本', async () => {
    handlers.set('load_project', () => modernFile())
    handlers.set('save_project', () => {
      throw new Error('磁盘满')
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { projectStore } = await load()
      const docOf = (name: string) => ({
        name,
        nodes: [],
        edges: [],
        settings: { characters: [], locations: [] },
      })
      await expect(projectStore.save('p1', docOf('最新'))).rejects.toThrow(
        '磁盘满',
      )
      // 红：直接读盘拿到的是滞后内容（现代剧），丢掉待重试的最新编辑
      const doc = await projectStore.load('p1')
      expect(doc.name).toBe('最新')
    } finally {
      errSpy.mockRestore()
    }
  })

  it('失败登记文档交付前过资产实路径复验：坏资产隔离并替换重试登记，后台重试以净载荷落盘', async () => {
    handlers.set('load_project', () => modernFile())
    handlers.set('verify_project_assets', () => ['a-1'])
    handlers.set('save_project', (args) => {
      const byId = (
        args as { doc: { assets: { byId: Record<string, unknown> } } }
      ).doc.assets.byId
      if ('a-1' in byId) throw new Error('资产 a-1：资产文件不存在')
      return undefined
    })
    vi.useFakeTimers()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { projectStore } = await load()
      const docOf = (name: string) => ({
        name,
        nodes: [],
        edges: [],
        settings: { characters: [], locations: [] },
      })
      const dirty = {
        ...docOf('最新'),
        assets: {
          byId: {
            'a-1': {
              id: 'a-1',
              relPath: 'assets/a-1.png',
              mime: 'image/png',
              source: 'upload',
              createdAt: '2026-01-01T00:00:00.000Z',
            },
          },
        },
      } as unknown as ProjectContent
      await expect(projectStore.save('p1', dirty)).rejects.toThrow('资产 a-1')
      // 红：登记文档直接经 memoryNormalize 交付，未过 verify_project_assets——
      // 坏资产保持活动、重试登记原样持有未复验内容，此后每次重试注定失败
      const doc = await projectStore.load('p1')
      expect(doc.assets?.byId['a-1']).toBeUndefined()
      await vi.advanceTimersByTimeAsync(5000)
      const saves = calls.filter((c) => c.cmd === 'save_project')
      expect(saves).toHaveLength(2)
      const retried = (
        saves[1].args as { doc: { assets: { byId: Record<string, unknown> } } }
      ).doc.assets.byId
      expect('a-1' in retried).toBe(false)
    } finally {
      errSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('复验等待期间登记被更新保存清除/替换：不得回写旧捕获文档，按当前保存状态重来', async () => {
    let releaseVerify: ((v: string[]) => void) | null = null
    let saveCalls = 0
    handlers.set('load_project', () => modernFile())
    let verifyCalls = 0
    handlers.set('verify_project_assets', () => {
      verifyCalls += 1
      // 首次（登记复验）挂起制造竞态窗口；磁盘路径的复验即答
      if (verifyCalls === 1) {
        return new Promise<string[]>((resolve) => {
          releaseVerify = resolve
        })
      }
      return Promise.resolve([])
    })
    handlers.set('save_project', () => {
      saveCalls += 1
      if (saveCalls === 1) throw new Error('磁盘满')
      return undefined
    })
    vi.useFakeTimers()
    try {
      const { projectStore } = await load()
      const docOf = (name: string) => ({
        name,
        nodes: [],
        edges: [],
        settings: { characters: [], locations: [] },
      })
      await expect(projectStore.save('p1', docOf('旧登记'))).rejects.toThrow(
        '磁盘满',
      )
      // load 捕获旧登记后进入复验等待
      const loading = projectStore.load('p1')
      await vi.waitFor(() => expect(releaseVerify).not.toBeNull())
      // 复验在途期间重试定时器触发且成功：登记被清除（磁盘已是最新）
      await vi.advanceTimersByTimeAsync(5000)
      ;(releaseVerify as unknown as (v: string[]) => void)([])
      const doc = await loading
      // 红：无条件 set 把旧捕获文档写回登记并交付——陈旧内容被编辑即覆盖
      // 新保存；须确认仍是观察到的那份才替换，否则按当前状态（磁盘）重来
      expect(doc.name).toBe('现代剧')
      expect(calls.some((c) => c.cmd === 'load_project')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('复验等待期间登记被取代且旧登记为脏形状：归一化前复查身份，加载不随已作废登记崩坏（PR #207 评审）', async () => {
    // 与上一用例同款的复验窗口，但旧登记带不可序列化的脏会话形状（缺
    // nodes）：身份复查若晚于归一化（先归一化再条件替换），memoryNormalize
    // 会在已作废文档上抛错——尽管较新的有效保存已经落盘，加载不应失败
    let releaseVerify: ((v: string[]) => void) | null = null
    handlers.set('load_project', () => modernFile())
    let verifyCalls = 0
    handlers.set('verify_project_assets', () => {
      verifyCalls += 1
      // 首次（登记复验）挂起制造竞态窗口；磁盘路径的复验即答
      if (verifyCalls === 1) {
        return new Promise<string[]>((resolve) => {
          releaseVerify = resolve
        })
      }
      return Promise.resolve([])
    })
    handlers.set('save_project', () => undefined)
    const { projectStore } = await load()
    // 脏形状登记：缺 nodes 的会话文档——序列化即抛错，save 以该失败登记
    const dirty = { name: '旧登记' } as unknown as ProjectContent
    await expect(projectStore.save('p1', dirty)).rejects.toThrow()
    // load 捕获旧登记后进入复验等待
    const loading = projectStore.load('p1')
    await vi.waitFor(() => expect(releaseVerify).not.toBeNull())
    // 复验在途期间新保存（合法内容）成功落盘：旧登记被清除
    await projectStore.save('p1', {
      name: '新保存',
      nodes: [],
      edges: [],
      settings: { characters: [], locations: [] },
    })
    ;(releaseVerify as unknown as (v: string[]) => void)([])
    const doc = await loading
    // 红：先归一化旧登记抛错，loading 整体拒绝；修复后归一化前复查身份，
    // 登记已清除即按当前状态重来，读到磁盘最新文件
    expect(doc.name).toBe('现代剧')
  })

  it('versionless IPC 标记触发回写补盖版本号：无版本文件不再永久无版本', async () => {
    // Rust 判型给缺 schemaVersion 的 v1 形状载荷打 versionless: true——
    // 额外键使前端 repaired 比较必然不等，回写落定显式版本（§10.5/§11.1）
    handlers.set('load_project', () => ({ ...modernFile(), versionless: true }))
    handlers.set('save_project', () => undefined)
    const { projectStore } = await load()
    await projectStore.load('p1')
    const save = calls.find((c) => c.cmd === 'save_project')
    expect(save).toBeDefined()
    // 回写载荷带显式 schemaVersion 且不再携带标记（持久化输出恒 false）
    const saved = (
      save?.args as { doc: { schemaVersion: number; versionless?: boolean } }
    ).doc
    expect(saved.schemaVersion).toBe(1)
    expect(saved.versionless).toBeUndefined()
  })

  it('assets 空白键重发：加载归一化把映射经 register_project_asset_alias 登记到 Rust（issue #31 评审修复 P2-3）', async () => {
    handlers.set('load_project', () => ({
      ...modernFile(),
      assets: {
        byId: {
          '': {
            id: '',
            relPath: 'assets/pa-1.png',
            mime: 'image/png',
            source: 'upload',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        },
      },
    }))
    handlers.set('save_project', () => undefined)
    handlers.set('register_project_asset_alias', () => undefined)
    const { projectStore } = await load()
    await projectStore.load('p1')
    const alias = calls.find((c) => c.cmd === 'register_project_asset_alias')
    expect(alias).toBeDefined()
    const args = alias?.args as {
      id: string
      blankKey: string
      freshId: string
    }
    expect(args.id).toBe('p1')
    expect(args.blankKey).toBe('')
    expect(args.freshId.trim().length).toBeGreaterThan(0)
    // 干净 v1 无空白键：不发起登记调用
    handlers.set('load_project', () => modernFile())
    calls.length = 0
    await projectStore.load('p1')
    expect(calls.some((c) => c.cmd === 'register_project_asset_alias')).toBe(
      false,
    )
  })

  it('别名登记 IPC 期间新保存入队：链身份守卫重来，修复回写不得晚于新保存覆盖新内容（issue #31 评审修复 P2-6）', async () => {
    let loadCalls = 0
    const storeBox: { current?: typeof import('./projectStore') } = {}
    // 脏 v1：空白资产键（触发别名登记）+ 空白边 id（触发修复回写）
    const dirtyFile = () => ({
      ...modernFile(),
      assets: {
        byId: {
          '': {
            id: '',
            relPath: 'assets/a.png',
            mime: 'image/png',
            source: 'upload',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        },
      },
      graph: {
        ...modernFile().graph,
        edges: [
          { id: '   ', source: 's1', target: 's1', data: { kind: 'sequence' } },
        ],
      },
    })
    handlers.set('load_project', () => {
      loadCalls += 1
      if (loadCalls === 1) return dirtyFile()
      // 守卫触发重来的读取：写后净本，不再触发回写与登记
      return {
        ...modernFile(),
        project: { ...modernFile().project, name: '写后净本' },
      }
    })
    handlers.set('save_project', () => undefined)
    handlers.set('register_project_asset_alias', () => {
      // 首次别名 IPC 在途：编辑器卸载冲刷把新保存排进链（此前链本静止）
      void storeBox.current?.projectStore
        .save('p1', {
          name: '冲刷的新编辑',
          nodes: [],
          edges: [],
          settings: { characters: [], locations: [] },
        })
        .catch(() => undefined)
      return undefined
    })
    const mod = await load()
    storeBox.current = mod
    const doc = await mod.projectStore.load('p1')
    // 旧内容的修复回写不得在冲刷之后落盘——登记后须复查链身份整体重来
    const saves = calls.filter((c) => c.cmd === 'save_project')
    expect(
      saves.map(
        (s) =>
          (s.args as { doc: { project: { name: string } } }).doc.project.name,
      ),
    ).toEqual(['冲刷的新编辑'])
    expect(doc.name).toBe('写后净本')
  })

  it('v1 修复型归一化回写 save_project（下次打开不再重复修复）；干净 v1 不回写', async () => {
    handlers.set('load_project', () => ({
      ...modernFile(),
      graph: {
        ...modernFile().graph,
        edges: [
          { id: '   ', source: 's1', target: 's1', data: { kind: 'sequence' } },
        ],
      },
    }))
    handlers.set('save_project', () => undefined)
    const { projectStore } = await load()
    await projectStore.load('p1')
    // 红：脏 v1（空白边 id + 自环隔离）修复只留内存——磁盘长留脏文件，
    // 每次打开都重新生成不同的"稳定" id
    expect(calls.some((c) => c.cmd === 'save_project')).toBe(true)

    // 干净 v1 不回写：无编辑的打开不得刷 updatedAt 改变首页最近项目排序
    handlers.set('load_project', () => modernFile())
    await projectStore.load('p1')
    expect(calls.filter((c) => c.cmd === 'save_project')).toHaveLength(1)
  })

  it('v1 缺失时间戳：前端归一化修复并回写——Rust 不再预合成，未动过的项目不再被每次 list 顶到最近列表顶端', async () => {
    handlers.set('load_project', () => ({
      ...modernFile(),
      project: { id: 'p1', name: '缺时间' },
    }))
    handlers.set('save_project', () => undefined)
    const { projectStore } = await load()
    const doc = await projectStore.load('p1')
    expect(doc.createdAt).toBeDefined()
    // 红：Rust 读取时就把缺失时间戳预合成为当前时刻，前端 repaired 检测
    // 看不见缺陷（载荷已是修好的值）——修复不回写，磁盘长留无时间戳文件
    expect(calls.some((c) => c.cmd === 'save_project')).toBe(true)
  })

  it('v1 文档解析为会话文档：spec/meta 拍平回节点 data', async () => {
    handlers.set('load_project', () => modernFile())
    const { projectStore } = await load()
    const doc = await projectStore.load('p1')
    expect(doc.name).toBe('现代剧')
    expect(doc.createdAt).toBe('2026-01-01T00:00:00.000Z')
    expect(doc.nodes[0].data).toMatchObject({
      name: '场一',
      sceneNo: 1,
      characterIds: [],
    })
  })

  it('旧格式（v0）触发迁移并回写 save_project（下次打开不再迁移）', async () => {
    handlers.set('load_project', () => legacyFile())
    handlers.set('save_project', () => undefined)
    const { projectStore } = await load()
    const doc: ProjectContent = await projectStore.load('p1')
    const scene = doc.nodes[0].data as {
      characterIds: string[]
      locationId?: string
    }
    expect(scene.characterIds).toHaveLength(1)
    expect(doc.settings.locations.map((l) => l.name)).toEqual(['天台'])
    // 回写是 fire-and-forget（void tauriSave）：轮询等到 save_project 落盘调用
    await vi.waitFor(() => {
      expect(calls.some((c) => c.cmd === 'save_project')).toBe(true)
    })
    const save = calls.find((c) => c.cmd === 'save_project')
    expect(save).toBeDefined()
    expect((save?.args as { id: string }).id).toBe('p1')
    // 回写内容为 v1 信封
    const savedDoc = (
      save?.args as { doc: { schemaVersion: number; episodeTitles: unknown } }
    ).doc
    expect(savedDoc.schemaVersion).toBe(1)
    expect(savedDoc.episodeTitles).toEqual({})
  })

  it('迁移回写先于返回：慢回写在途时 load 不得返回（后续改名保存不被旧内容覆盖）', async () => {
    let releaseWriteback: (() => void) | null = null
    handlers.set('load_project', () => legacyFile())
    handlers.set(
      'save_project',
      () =>
        new Promise<void>((resolve) => {
          if (releaseWriteback === null) {
            // 首个调用 = 迁移回写：挂起模拟慢盘
            releaseWriteback = resolve
            return
          }
          resolve()
        }),
    )
    const { projectStore } = await load()
    const loaded = projectStore.load('p1')
    let returned = false
    void loaded.then(() => {
      returned = true
    })
    // 等到迁移回写已发起并挂起（慢盘）
    await vi.waitFor(() => {
      expect(calls.filter((c) => c.cmd === 'save_project')).toHaveLength(1)
    })
    // 回写在途：load 不得先于回写完成而返回（否则紧随的保存会被慢回写反向覆盖）
    expect(returned).toBe(false)
    ;(releaseWriteback as unknown as (() => void) | undefined)?.()
    const doc = await loaded
    // 回写完成后，紧随的改名保存是最后一个落盘者
    await projectStore.save('p1', { ...doc, name: '新名' })
    const saves = calls.filter((c) => c.cmd === 'save_project')
    expect(saves).toHaveLength(2)
    const last = saves[saves.length - 1]
    expect(
      (last.args as { doc: { project: { name: string } } }).doc.project.name,
    ).toBe('新名')
  })

  it('回写失败：内存副本照常交付，显式诊断且不留未处理拒绝', async () => {
    handlers.set('load_project', () => legacyFile())
    handlers.set('save_project', () => {
      throw new Error('目录只读')
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { projectStore } = await load()
      const doc = await projectStore.load('p1')
      expect(doc.name).toBe('旧剧')
      await vi.waitFor(() => {
        expect(
          errSpy.mock.calls.some((c) => String(c[0]).includes('回写失败')),
        ).toBe(true)
      })
    } finally {
      errSpy.mockRestore()
    }
  })

  it('加载侧资产实路径复验：不可验证键传入归一化层隔离，引用位标记悬空', async () => {
    handlers.set('load_project', () => ({
      ...modernFile(),
      assets: {
        byId: {
          'a-1': {
            id: 'a-1',
            relPath: 'assets/lost.png',
            mime: 'image/png',
            source: 'upload',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        },
      },
    }))
    handlers.set('verify_project_assets', () => ['a-1'])
    const { projectStore } = await load()
    const doc = await projectStore.load('p1')
    expect(doc.assets?.byId['a-1']).toBeUndefined()
    // 复验命令拿到的是刚加载文档的资产索引
    const verify = calls.find((c) => c.cmd === 'verify_project_assets')
    expect((verify?.args as { id: string }).id).toBe('p1')
    const sent = (verify?.args as { assets: { byId: unknown } }).assets
    expect(
      (sent as { byId: Record<string, unknown> }).byId['a-1'],
    ).toBeDefined()
  })
})

describe('tauriLoad：graph 容器扩展字段（issue #100 同版本字段演进）', () => {
  it('打开零回写，真实保存原样落盘', async () => {
    const file = modernFile() as Record<string, unknown>
    ;(file.graph as Record<string, unknown>).futureGraphNote = '构造未来字段'
    handlers.set('load_project', () => file)
    handlers.set('save_project', () => undefined)
    const { projectStore } = await load()
    const doc = await projectStore.load('p1')
    // 红：归一化曾把未知 graph 键当结构变化（repaired=true），仅打开就把
    // 删除落实回写；保留策略下扩展字段不是缺陷，净本零写盘
    expect(calls.map((c) => c.cmd)).toEqual([
      'load_project',
      'verify_project_assets',
    ])
    expect(doc.graphExtensions).toEqual({ futureGraphNote: '构造未来字段' })
    // 用户编辑触发真实保存：扩展字段随序列化原样落盘，不因会话往返丢失
    await projectStore.save('p1', { ...doc, name: '编辑后' })
    const saved = calls.find((c) => c.cmd === 'save_project') as unknown as {
      args: { doc: { graph: Record<string, unknown>; nodes: unknown[] } }
    }
    expect(saved.args.doc.graph.futureGraphNote).toBe('构造未来字段')
    expect(saved.args.doc.graph.nodes).toHaveLength(1)
  })
})

describe('tauriList：空库播种与示例升级', () => {
  it('损坏占位（issue #123）：列表携带诊断的条目映射为占位摘要，非空列表不触发播种探测', async () => {
    // Rust 列表对损坏/不可读项目返回带 diagnostic 的占位摘要：坏项目
    // 在首页可见可定位；列表非空即不走空库播种（坏文件不被种子覆盖）。
    // 两个同因坏项目的占位名须各携受信 id（PR #196 评审）：id 即
    // projects/ 下文件名主干，否则卡片/删除确认同名不可区分，用户可能
    // 删错坏文件
    handlers.set('list_projects', () => [
      meta('p1'),
      {
        id: 'p-bad',
        name: '',
        updated_at: '',
        scene_count: 0,
        ending_count: 0,
        diagnostic: '项目文件损坏：无法判别文档信封（已保留原文件）',
      },
      {
        id: 'p-bad-2',
        name: '',
        updated_at: '',
        scene_count: 0,
        ending_count: 0,
        diagnostic: '项目文件损坏：无法判别文档信封（已保留原文件）',
      },
    ])
    const { projectStore } = await load()
    const list = await projectStore.list()
    expect(list.map((x) => x.id)).toEqual(['p1', 'p-bad', 'p-bad-2'])
    const broken = list[1]!
    expect(broken.name).toBe('无法读取的项目（p-bad）')
    expect(broken.error).toBe('项目文件损坏：无法判别文档信封（已保留原文件）')
    // 同因坏项目占位名不同（各含受信 id），删除确认可点名唯一目标
    expect(list[2]!.name).toBe('无法读取的项目（p-bad-2）')
    // 非法时间戳回退 epoch（卡片损坏变体不展示时间，不因 Date 抛错）
    expect(broken.updatedAt).toBe(new Date(0).toISOString())
    expect(calls.filter((c) => c.cmd === 'load_project')).toHaveLength(0)
  })

  it('空列表≠空目录：唯一项目是不可读的坏文件时不播种、不覆盖可能可恢复的内容', async () => {
    // list_project_metas 跳过损坏/不可读文件——唯一项目若是 JSON 损坏的
    // 已编辑示例，metas 为空但目录非空；播种必须是 no-replace 语义
    let listCalls = 0
    handlers.set('list_projects', () => {
      listCalls += 1
      // 恒空会令现实现播种后无限递归；重列返回播种产物使递归有界
      return listCalls === 1 ? [] : [meta('sample-wu-ye-chu-zu-che')]
    })
    handlers.set('load_project', () => {
      throw new Error('项目文件损坏：无法判别文档信封（已保留原文件）')
    })
    handlers.set('save_project', () => undefined)
    const { projectStore } = await load()
    const list = await projectStore.list()
    // 红：无条件播种会用硬编码种子原子覆盖可能可恢复的用户文件
    expect(calls.filter((c) => c.cmd === 'save_project')).toHaveLength(0)
    expect(list.map((x) => x.id)).toEqual([])
  })

  it('无码的「项目不存在」文案不触发播种：程序判定只认机器码（issue #229）', async () => {
    // 不存在/不可读/未知三类可区分：无 [project_not_found] 码的错误
    // （旧后端裸文案、Io、损坏）一律按「存在但不可读」保守跳过——
    // 改变/本地化展示文案不得改变播种行为
    let listCalls = 0
    handlers.set('list_projects', () => {
      listCalls += 1
      return listCalls === 1 ? [] : [meta('sample-wu-ye-chu-zu-che')]
    })
    handlers.set('load_project', () => {
      throw new Error('项目不存在：sample-wu-ye-chu-zu-che')
    })
    handlers.set('save_project', () => undefined)
    const { projectStore } = await load()
    const list = await projectStore.list()
    expect(calls.filter((c) => c.cmd === 'save_project')).toHaveLength(0)
    expect(list.map((x) => x.id)).toEqual([])
  })

  it('示例为未来版本（schemaVersion 高于当前）：升级检查单例隔离，list 不中止、摘要原样', async () => {
    handlers.set('list_projects', () => [
      meta('sample-wu-ye-chu-zu-che'),
      meta('user-p1'),
    ])
    handlers.set('load_project', () => ({ ...modernFile(), schemaVersion: 99 }))
    const { projectStore } = await load()
    // 红：parseProject 抛「版本过新」令 list 整体拒绝，首页被清成空列表
    const list = await projectStore.list()
    expect(list.map((x) => x.id)).toEqual([
      'sample-wu-ye-chu-zu-che',
      'user-p1',
    ])
  })

  it('首次（无项目文件）写入两个种子项目后重列', async () => {
    let listed = false
    handlers.set('list_projects', () => {
      if (listed) {
        return [
          meta('sample-wu-ye-chu-zu-che'),
          meta('sample-du-shi-qi-yuan'),
          meta('user-p1'),
        ]
      }
      listed = true
      return []
    })
    handlers.set('save_project', () => undefined)
    // 播种是 no-replace：探测期（文件未写）返回带机器码的「项目不存在」
    // （issue #229：程序判定只认 [project_not_found] 码，不经中文文案），
    // 播种后重列的升级检查读到各自携带匹配 project.id 的干净 v1 信封 →
    // 无需覆盖（id 与受信路径不一致会被 §11.1 受信 id 覆盖修复改写并触发回写）
    let loadCalls = 0
    handlers.set('load_project', (args) => {
      loadCalls += 1
      if (loadCalls <= 2)
        throw new Error(
          `[project_not_found] 项目不存在：${(args as { id: string }).id}`,
        )
      return {
        ...modernFile(),
        project: { ...modernFile().project, id: (args as { id: string }).id },
      }
    })
    const { projectStore } = await load()
    const list = await projectStore.list()
    expect(list.map((x) => x.id)).toEqual([
      'sample-wu-ye-chu-zu-che',
      'sample-du-shi-qi-yuan',
      'user-p1',
    ])
    // 两个种子各写盘一次
    expect(calls.filter((c) => c.cmd === 'save_project')).toHaveLength(2)
    expect(list[0].updatedAt).toBe(UPDATED_ISO)
    expect(list[0].endingCount).toBe(2)
  })

  it('示例迁移/修复回写后重列：首页拿到写后的名称与排序，不滞留写前快照', async () => {
    let listCalls = 0
    handlers.set('list_projects', () => {
      listCalls += 1
      if (listCalls === 1)
        return [{ ...meta('sample-wu-ye-chu-zu-che'), name: '旧名' }]
      return [{ ...meta('sample-wu-ye-chu-zu-che'), name: '新名' }]
    })
    let loadCalls = 0
    handlers.set('load_project', () => {
      loadCalls += 1
      if (loadCalls === 1) {
        // 脏 v1（空白边 id）：触发修复回写
        return {
          ...modernFile(),
          project: {
            ...modernFile().project,
            id: 'sample-wu-ye-chu-zu-che',
            name: '新名',
          },
          graph: {
            ...modernFile().graph,
            edges: [
              {
                id: '   ',
                source: 's1',
                target: 's1',
                data: { kind: 'sequence' },
              },
            ],
          },
        }
      }
      // 回写后的净本：重列的升级检查不再触发写
      return {
        ...modernFile(),
        project: {
          ...modernFile().project,
          id: 'sample-wu-ye-chu-zu-che',
          name: '新名',
        },
      }
    })
    handlers.set('save_project', () => undefined)
    const { projectStore } = await load()
    const list = await projectStore.list()
    // 红：返回写前快照——首页滞留旧名直到下次刷新
    expect(list[0].name).toBe('新名')
    expect(calls.filter((c) => c.cmd === 'save_project')).toHaveLength(1)
  })

  it('示例项目仍是旧格式但已被编辑：迁移回写用户内容，不用新种子覆盖', async () => {
    handlers.set('list_projects', () => [
      meta('sample-wu-ye-chu-zu-che'),
      meta('user-p1'),
    ])
    let loadCalls = 0
    handlers.set('load_project', (args) => {
      const { id } = args as { id: string }
      if (id !== 'sample-wu-ye-chu-zu-che') throw new Error('不应读取用户项目')
      loadCalls += 1
      if (loadCalls === 1) {
        // 用户编辑过的示例（已改名，仍是 v0 旧扁平格式）
        return {
          ...legacyFile(),
          project: { ...legacyFile().project, id, name: '我的修改版' },
        }
      }
      // 回写后的净本（重列的升级检查读到迁移产物，不再触发写）
      return {
        ...modernFile(),
        project: { ...modernFile().project, id, name: '我的修改版' },
      }
    })
    handlers.set('save_project', () => undefined)
    const { projectStore } = await load()
    const list = await projectStore.list()
    // 迁移回写触发重列：示例被读取两次（初检 + 重列复检）、只写一次
    expect(calls.filter((c) => c.cmd === 'load_project')).toHaveLength(2)
    const saves = calls.filter((c) => c.cmd === 'save_project')
    expect(saves).toHaveLength(1)
    // 写回的是迁移后的用户内容，不是硬编码种子的「午夜出租车」
    const saved = (
      saves[0].args as {
        doc: { schemaVersion: number; project: { name: string } }
      }
    ).doc
    expect(saved.schemaVersion).toBe(1)
    expect(saved.project.name).toBe('我的修改版')
    // 重列返回的首页列表就绪（不再抛未处理拒绝）
    expect(list.map((x) => x.id)).toContain('sample-wu-ye-chu-zu-che')
  })

  it('示例形状判型（versionless 标记）：升级回写前逐条记录判型警告，不静默改写版本号（issue #338 评审二轮）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    handlers.set('list_projects', () => [meta('sample-wu-ye-chu-zu-che')])
    let loadCalls = 0
    handlers.set('load_project', () => {
      loadCalls += 1
      if (loadCalls === 1) {
        // Rust 形状判型产物：版本主张缺失/异型按 v1 形状交付并打标记
        return {
          ...modernFile(),
          versionless: true,
          project: {
            ...modernFile().project,
            id: 'sample-wu-ye-chu-zu-che',
          },
        }
      }
      // 回写后的净本：重列的升级检查不再触发写
      return {
        ...modernFile(),
        project: { ...modernFile().project, id: 'sample-wu-ye-chu-zu-che' },
      }
    })
    handlers.set('save_project', () => undefined)
    const { projectStore } = await load()
    await projectStore.list()
    // 升级路径与 tauriLoad 同款逐条留痕——判型警告不能只在打开时可见
    expect(
      warnSpy.mock.calls.some((args) =>
        args.some((a) => typeof a === 'string' && a.includes('信封形状判型')),
      ),
    ).toBe(true)
    // 标记触发修复回写（版本号被显式补盖）——正因要回写才必须留痕
    expect(calls.filter((c) => c.cmd === 'save_project')).toHaveLength(1)
    warnSpy.mockRestore()
  })

  it('示例迁移/修复回写前先过加载侧资产复验：不可验证键隔离后再回写，坏资产不再让 list 中止、首页清空', async () => {
    handlers.set('list_projects', () => [
      meta('sample-wu-ye-chu-zu-che'),
      meta('user-p1'),
    ])
    let loadCalls = 0
    handlers.set('load_project', (args) => {
      const { id } = args as { id: string }
      if (id !== 'sample-wu-ye-chu-zu-che') throw new Error('不应读取用户项目')
      loadCalls += 1
      if (loadCalls === 1) {
        // 脏 v1 示例（空白边 id 触发修复），索引带一个 Rust 实路径复验
        // 不过（文件缺失）的资产
        return {
          ...modernFile(),
          project: { ...modernFile().project, id, name: '我的修改版' },
          graph: {
            ...modernFile().graph,
            edges: [
              {
                id: '   ',
                source: 's1',
                target: 's1',
                data: { kind: 'sequence' },
              },
            ],
          },
          assets: {
            byId: {
              'a-1': {
                id: 'a-1',
                relPath: 'assets/lost.png',
                mime: 'image/png',
                source: 'upload',
                createdAt: '2026-01-01T00:00:00.000Z',
              },
            },
          },
        }
      }
      // 回写后的净本：坏资产已隔离，重列复检不再触发写
      return {
        ...modernFile(),
        project: { ...modernFile().project, id, name: '我的修改版' },
      }
    })
    handlers.set('verify_project_assets', (args) => {
      const sent = (args as { assets: { byId?: Record<string, unknown> } })
        .assets
      return sent.byId?.['a-1'] !== undefined ? ['a-1'] : []
    })
    // 保存边界（§10.5）对不可验证资产整次拒收：mock 复刻该契约
    handlers.set('save_project', (args) => {
      const doc = (
        args as { doc: { assets?: { byId?: Record<string, unknown> } } }
      ).doc
      if (doc.assets?.byId?.['a-1'] !== undefined) {
        throw new Error('资产 a-1：资产文件不存在：assets/lost.png')
      }
      return undefined
    })
    const { projectStore } = await load()
    const list = await projectStore.list()
    // 红（修复前）：tauriList 不做资产复验，回写被保存边界拒收 → list 整体抛错
    expect(list.map((x) => x.id)).toContain('sample-wu-ye-chu-zu-che')
    // 复验以示例 id 与其资产索引调用，回写文档已隔离坏资产
    const verify = calls.find((c) => c.cmd === 'verify_project_assets')
    expect((verify?.args as { id: string }).id).toBe('sample-wu-ye-chu-zu-che')
    const saves = calls.filter((c) => c.cmd === 'save_project')
    expect(saves).toHaveLength(1)
    const saved = (
      saves[0].args as { doc: { assets: { byId: Record<string, unknown> } } }
    ).doc
    expect(saved.assets.byId['a-1']).toBeUndefined()
  })
})

describe('tauriCreate / delete / duplicate', () => {
  it('create 与 delete 的命令透传', async () => {
    handlers.set('create_project', () => ({ ...meta('new-1'), name: '新剧' }))
    handlers.set('delete_project', () => undefined)
    const { projectStore } = await load()
    const created = await projectStore.create('新剧')
    expect(created.id).toBe('new-1')
    expect(calls[0]).toEqual({ cmd: 'create_project', args: { name: '新剧' } })
    await projectStore.delete('new-1')
    expect(calls[1]).toEqual({ cmd: 'delete_project', args: { id: 'new-1' } })
  })

  it('重叠删除混合成败：成功笔已移除项目时，失败笔不得回吐重建（PR #224 第十轮评审）', async () => {
    const savedIds: string[] = []
    handlers.set('save_project', (args) => {
      savedIds.push((args as { id: string }).id)
    })
    const releasers: Array<() => void> = []
    const failSecond = { value: false }
    handlers.set(
      'delete_project',
      () =>
        new Promise<void>((resolve, reject) => {
          if (failSecond.value) reject(new Error('瞬态删除失败'))
          else releasers.push(resolve)
        }),
    )
    const { projectStore } = await load()
    // 首笔删除（将成功）；重叠的第二笔（将失败）
    const first = projectStore.delete('p-x')
    await new Promise((resolve) => setTimeout(resolve, 20))
    failSecond.value = true
    const second = projectStore.delete('p-x')
    await new Promise((resolve) => setTimeout(resolve, 20))
    // 放行首笔（成功移除项目）；第二笔随后失败——其回吐分支不得重放
    // 任何吸收写入（组级已成功）
    releasers.shift()?.()
    await expect(Promise.all([first, second])).rejects.toThrow(/瞬态删除失败/)
    await new Promise((resolve) => setTimeout(resolve, 50))
    // 重放会用 create-if-missing 复活已删项目：save_project 不得为 p-x 落盘
    expect(savedIds.filter((id) => id === 'p-x')).toEqual([])
  })

  it('重叠删除收尾失败：组级成功须活到拒绝处理器判完（PR #224 第十一轮评审）', async () => {
    const savedIds: string[] = []
    handlers.set('save_project', (args) => {
      savedIds.push((args as { id: string }).id)
    })
    // 首笔成功、第二笔挂起后失败（收尾失败序）
    let resolveFirst!: () => void
    let rejectSecond!: (e: Error) => void
    let deleteCount = 0
    handlers.set(
      'delete_project',
      () =>
        new Promise<void>((resolve, reject) => {
          deleteCount += 1
          if (deleteCount === 1) resolveFirst = resolve
          else rejectSecond = reject
        }),
    )
    const { projectStore } = await load()
    const first = projectStore.delete('p-x')
    await new Promise((resolve) => setTimeout(resolve, 20))
    const second = projectStore.delete('p-x')
    await new Promise((resolve) => setTimeout(resolve, 20))
    // 第二笔在途期间：普通保存被吸收（墓碑仍在）
    await projectStore.save('p-x', {
      name: '吸收稿',
      nodes: [],
      edges: [],
      settings: { characters: [], locations: [] },
    })
    // 首笔成功落定 → 组级成功置位；第二笔失败 → 失败处理器判 group
    //（红态：标记已被 finally/成功分支提前清除 → 误重放复活）
    resolveFirst()
    await new Promise((resolve) => setTimeout(resolve, 20))
    rejectSecond(new Error('瞬态失败'))
    await expect(Promise.allSettled([first, second])).resolves.toBeDefined()
    await new Promise((resolve) => setTimeout(resolve, 50))
    // 吸收的文档不得被重放复活（save_project 零落盘）
    expect(savedIds.filter((id) => id === 'p-x')).toEqual([])
  })

  it('重叠删除共享墓碑至最后一笔落定：间隙内的迟到普通保存仍被吸收（PR #224 第八轮评审）', async () => {
    const savedIds: string[] = []
    handlers.set('save_project', (args) => {
      savedIds.push((args as { id: string }).id)
    })
    const releasers: Array<() => void> = []
    handlers.set(
      'delete_project',
      () =>
        new Promise<void>((resolve) => {
          releasers.push(resolve)
        }),
    )
    const { projectStore } = await load()
    // 首笔删除挂起（墓碑计数=1）
    const first = projectStore.delete('p-x')
    await new Promise((resolve) => setTimeout(resolve, 20))
    // 重叠的第二笔删除（如 duplicate 清理分支）：同链排队，计数=2
    const second = projectStore.delete('p-x')
    await new Promise((resolve) => setTimeout(resolve, 20))
    // 放行首笔：墓碑不得随之解除（第二笔仍在途）
    releasers.shift()?.()
    await new Promise((resolve) => setTimeout(resolve, 30))
    // 首笔落定后的间隙：迟到普通保存必须被吸收（不得越顶重建）
    const lateDoc = {
      name: '迟到保存',
      nodes: [],
      edges: [],
      settings: { characters: [], locations: [] },
    }
    const lateSave = projectStore.save('p-x', lateDoc)
    await new Promise((resolve) => setTimeout(resolve, 30))
    // 放行第二笔并等待全部落定
    releasers.shift()?.()
    await Promise.all([first, second, lateSave])
    // 保存被吸收（删除成功即丢弃）：save_project 不得为 p-x 落盘
    expect(savedIds.filter((id) => id === 'p-x')).toEqual([])
  })

  it('副本保存遇活跃删除墓碑即拒绝，duplicate 报失败并清理（PR #224 第七轮评审：吸收会让 flag 被丢弃、复制报成功）', async () => {
    handlers.set('load_project', () => modernFile())
    handlers.set('list_projects', () => [meta('p1')])
    handlers.set('create_project', (args) => ({
      ...meta('copy-t'),
      name: (args as { name: string }).name,
    }))
    handlers.set('copy_project_assets', () => undefined)
    let saveReached = false
    handlers.set('save_project', (args) => {
      if ((args as { id: string }).id === 'copy-t') saveReached = true
    })
    const deletedIds: string[] = []
    const releasers: Array<() => void> = []
    handlers.set('delete_project', (args) => {
      deletedIds.push((args as { id: string }).id)
      return new Promise<void>((resolve) => {
        releasers.push(resolve)
      })
    })
    const { projectStore } = await load()
    // 首个删除挂起：copy-t 的删除墓碑活跃
    const deleting = projectStore.delete('copy-t')
    await new Promise((resolve) => setTimeout(resolve, 20))
    // 墓碑窗口内发起 duplicate：load/create/copy 可进行，后续保存被拒绝
    //（不得吸收报成功）→ catch 清理分支再排队一笔删除
    // 立即挂 rejection 观察者（避免 50ms 窗口内的未处理拒绝）
    const duplicating = projectStore.duplicate('p1')
    const verdict = duplicating.then(
      () => 'resolved',
      (err: unknown) => `rejected:${String(err)}`,
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(saveReached).toBe(false)
    // 放行全部挂起/后续入队的删除，两笔删除与 duplicate 全部落定
    for (
      let i = 0;
      i < 50 && (deletedIds.length < 2 || releasers.length > 0);
      i += 1
    ) {
      for (const release of releasers.splice(0)) release()
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    for (const release of releasers.splice(0)) release()
    await expect(verdict).resolves.toMatch(/^rejected:/)
    await expect(duplicating).rejects.toThrow(/删除中|不存在/)
    await deleting
    expect(deletedIds).toContain('copy-t')
  })

  it('duplicate 的后续保存带 expectExisting=true（PR #224 评审：copy 后目标被排队的删除移走时不复活）', async () => {
    handlers.set('load_project', () => modernFile())
    handlers.set('create_project', () => ({
      ...meta('copy-9'),
      name: 'X 副本',
    }))
    handlers.set('copy_project_assets', () => undefined)
    let savedWith: unknown
    handlers.set('save_project', (args) => {
      savedWith = args
    })
    const { projectStore } = await load()
    await projectStore.duplicate('p1')
    expect((savedWith as { expectExisting?: boolean }).expectExisting).toBe(
      true,
    )
  })

  it('duplicate = load → create → copy_project_assets → save 全链路（副本名拼接）', async () => {
    handlers.set('load_project', () => modernFile())
    handlers.set('create_project', (args) => ({
      ...meta('copy-1'),
      name: (args as { name: string }).name,
    }))
    handlers.set('copy_project_assets', () => undefined)
    handlers.set('save_project', () => undefined)
    const { projectStore } = await load()
    const copy = await projectStore.duplicate('p1')
    expect(copy.name).toBe('现代剧 副本')
    const save = calls.find((c) => c.cmd === 'save_project')
    const savedDoc = (save?.args as { doc: { project: { name: string } } }).doc
    expect(savedDoc.project.name).toBe('现代剧 副本')
  })

  it('duplicate：带资产索引的项目先整目录拷贝(from→to)再保存，供 §10.5 实路径复验通过', async () => {
    handlers.set('load_project', () => ({
      ...modernFile(),
      assets: {
        byId: {
          'a-1': {
            id: 'a-1',
            relPath: 'assets/x.png',
            mime: 'image/png',
            source: 'upload',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        },
      },
    }))
    handlers.set('create_project', () => meta('copy-9'))
    handlers.set('copy_project_assets', () => undefined)
    handlers.set('save_project', () => undefined)
    const { projectStore } = await load()
    await projectStore.duplicate('p1')
    const copyCall = calls.find((c) => c.cmd === 'copy_project_assets')
    expect(copyCall?.args).toEqual({ fromId: 'p1', toId: 'copy-9' })
    const order = calls.map((c) => c.cmd)
    expect(order.indexOf('copy_project_assets')).toBeLessThan(
      order.indexOf('save_project'),
    )
  })

  it('duplicate：保存失败向前抛出并清理刚建的空副本，不再静默返回空项目', async () => {
    handlers.set('load_project', () => modernFile())
    handlers.set('create_project', () => meta('copy-x'))
    handlers.set('copy_project_assets', () => undefined)
    handlers.set('save_project', () => {
      throw new Error('资产 a-1：资产文件不存在：assets/x.png')
    })
    handlers.set('delete_project', () => undefined)
    const { projectStore } = await load()
    await expect(projectStore.duplicate('p1')).rejects.toThrow(/资产文件不存在/)
    const cleanup = calls.find((c) => c.cmd === 'delete_project')
    expect((cleanup?.args as { id: string }).id).toBe('copy-x')
  })

  it('duplicate：保存与清理双双失败——合并错误向前抛出，报告可能遗留的副本 id', async () => {
    handlers.set('load_project', () => modernFile())
    handlers.set('create_project', () => meta('copy-y'))
    handlers.set('copy_project_assets', () => undefined)
    // 只让两次 duplicate 主流程的保存失败；删除失败后回吐的重存放行——
    // 回吐再失败会留下跨用例的 5s 重试定时器，把保存调用注入后续用例
    let saveCalls = 0
    handlers.set('save_project', () => {
      saveCalls += 1
      if (saveCalls === 1 || saveCalls === 3) {
        throw new Error('资产 a-1：资产文件不存在：assets/x.png')
      }
      return undefined
    })
    handlers.set('delete_project', () => {
      throw new Error('目录只读，删不掉')
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { projectStore } = await load()
      await expect(projectStore.duplicate('p1')).rejects.toThrow(/copy-y/)
      // 第一次 duplicate 的回吐重存落定后再开第二轮：与其 import 竞态
      await vi.waitFor(() => {
        expect(calls.filter((c) => c.cmd === 'save_project')).toHaveLength(2)
      })
      await expect(projectStore.duplicate('p1')).rejects.toThrow(/清理失败/)
    } finally {
      errSpy.mockRestore()
    }
  })
})

describe('项目级持久化所有者（保存失败重试不随编辑器卸载而丢编辑）', () => {
  it('保存失败后按节律后台重试，最终以最新文档落盘', async () => {
    let failures = 3 // 初始 v1、重试 v1、新文档 v2 各失败一次，之后的重试成功
    handlers.set('load_project', () => modernFile())
    handlers.set('save_project', () => {
      if (failures > 0) {
        failures -= 1
        throw new Error('磁盘满')
      }
      return undefined
    })
    vi.useFakeTimers()
    try {
      const { projectStore } = await load()
      await expect(
        projectStore.save('p1', {
          name: 'v1',
          nodes: [],
          edges: [],
          settings: { characters: [], locations: [] },
        }),
      ).rejects.toThrow('磁盘满')
      await vi.advanceTimersByTimeAsync(5000)
      await expect(
        projectStore.save('p1', {
          name: 'v2',
          nodes: [],
          edges: [],
          settings: { characters: [], locations: [] },
        }),
      ).rejects.toThrow('磁盘满')
      // 编辑器此时卸载：无组件持有文档——所有者仍按节律重试最新（v2）文档
      await vi.advanceTimersByTimeAsync(5000)
      await vi.advanceTimersByTimeAsync(5000)
      const saves = calls.filter((c) => c.cmd === 'save_project')
      expect(saves.length).toBeGreaterThanOrEqual(3)
      const last = saves[saves.length - 1].args as {
        doc: { project: { name: string } }
      }
      expect(last.doc.project.name).toBe('v2')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('持久化所有者的代次与删除串行（陈旧重试/复活防护）', () => {
  // 陈旧重试作废/删除取消重试等链级不变量由 projectStore/saveChain.test.ts
  // 所有；此处保留门面集成代表（issue #291 精简重复覆盖）。

  it('删除排在在途保存之后：保存完成前不得发出 delete_project', async () => {
    let releaseSave: (() => void) | null = null
    handlers.set('load_project', () => modernFile())
    handlers.set(
      'save_project',
      () =>
        new Promise<void>((resolve) => {
          releaseSave = resolve
        }),
    )
    handlers.set('delete_project', () => undefined)
    const { projectStore } = await load()
    const saving = projectStore.save('p1', {
      name: 'x',
      nodes: [],
      edges: [],
      settings: { characters: [], locations: [] },
    })
    const deleting = projectStore.delete('p1')
    // 等保存真正挂起（invoke 链有多跳微任务），删除此时不得越过它
    await vi.waitFor(() => expect(releaseSave).not.toBeNull())
    expect(calls.some((c) => c.cmd === 'delete_project')).toBe(false) // 红：未串行即提前发出
    ;(releaseSave as unknown as (() => void) | undefined)?.()
    await saving
    await deleting
    expect(calls.some((c) => c.cmd === 'delete_project')).toBe(true)
  })
})

describe('持久化所有者的代次重排与删除墓碑', () => {
  const docOf = (name: string) => ({
    name,
    nodes: [],
    edges: [],
    settings: { characters: [], locations: [] },
  })

  // 重试定时器接管/吸收不复活等链级不变量由 projectStore/saveChain.test.ts
  // 所有；此处保留删除失败回吐的门面集成代表（issue #291 精简重复覆盖）。
  it('删除失败时回吐删除期间吸收的最新文档重存：迟到编辑不落空', async () => {
    let rejectDelete: ((err: Error) => void) | null = null
    handlers.set('load_project', () => modernFile())
    handlers.set('save_project', () => undefined)
    handlers.set(
      'delete_project',
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectDelete = reject
        }),
    )
    const { projectStore } = await load()
    const deleting = projectStore.delete('p1')
    // 删除在途期间，编辑器卸载冲刷被墓碑吸收（视为成功但未落盘）
    await projectStore.save('p1', docOf('旧迟到'))
    await projectStore.save('p1', docOf('新迟到'))
    expect(calls.some((c) => c.cmd === 'save_project')).toBe(false)
    // 等 delete_project 真正挂起（invoke 链有多跳微任务）再令其失败
    await vi.waitFor(() => expect(rejectDelete).not.toBeNull())
    ;(rejectDelete as unknown as (err: Error) => void)(new Error('占用'))
    await expect(deleting).rejects.toThrow('占用')
    // 红：吸收的文档随墓碑清除被丢弃——项目仍在磁盘，最新编辑既没落盘也无重试
    await vi.waitFor(() => {
      const names = calls
        .filter((c) => c.cmd === 'save_project')
        .map(
          (c) =>
            (c.args as { doc: { project: { name: string } } }).doc.project.name,
        )
      expect(names).toEqual(['新迟到']) // 只回吐最新一份
    })
  })
})
