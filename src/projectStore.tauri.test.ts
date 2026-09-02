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

const load = async (): Promise<typeof import('./projectStore')> => import('./projectStore')

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
  project: { id: 'p1', name: '现代剧', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: UPDATED_ISO },
  graph: {
    nodes: [
      {
        id: 's1',
        type: 'scene',
        layout: { position: { x: 0, y: 0 } },
        ui: { selected: false, expanded: true },
        data: {
          spec: { sceneNo: 1, interior: true, time: '🌙 夜', synopsis: '', characterIds: [] },
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
          name: '场一', sceneNo: 1, interior: true, time: '🌙 夜', synopsis: '',
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
      episodeTitles: { 1: ' 开局 ', 2: '   ', x: 'y', 0: '零', '-1': '负', '3.5': '小数', 4: 7 },
    }))
    handlers.set('save_project', () => undefined)
    const { projectStore } = await load()
    const doc = await projectStore.load('p1')
    expect(doc.episodeTitles).toEqual({ 1: '开局' })
    // 修复型归一化（键值域修复）同样回写落定；加载侧资产复验固定先行
    expect(calls.map((c) => c.cmd)).toEqual(['load_project', 'verify_project_assets', 'save_project'])
  })

  it('v1 修复型归一化回写 save_project（下次打开不再重复修复）；干净 v1 不回写', async () => {
    handlers.set('load_project', () => ({
      ...modernFile(),
      graph: {
        ...modernFile().graph,
        edges: [{ id: '   ', source: 's1', target: 's1', data: { kind: 'sequence' } }],
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
    expect(doc.nodes[0].data).toMatchObject({ name: '场一', sceneNo: 1, characterIds: [] })
  })

  it('旧格式（v0）触发迁移并回写 save_project（下次打开不再迁移）', async () => {
    handlers.set('load_project', () => legacyFile())
    handlers.set('save_project', () => undefined)
    const { projectStore } = await load()
    const doc: ProjectContent = await projectStore.load('p1')
    const scene = doc.nodes[0].data as { characterIds: string[]; locationId?: string }
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
    const savedDoc = (save?.args as { doc: { schemaVersion: number; episodeTitles: unknown } }).doc
    expect(savedDoc.schemaVersion).toBe(1)
    expect(savedDoc.episodeTitles).toEqual({})
  })

  it('迁移回写先于返回：慢回写在途时 load 不得返回（后续改名保存不被旧内容覆盖）', async () => {
    let releaseWriteback: (() => void) | null = null
    handlers.set('load_project', () => legacyFile())
    handlers.set('save_project', () =>
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
    expect((last.args as { doc: { project: { name: string } } }).doc.project.name).toBe('新名')
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
          'a-1': { id: 'a-1', relPath: 'assets/lost.png', mime: 'image/png', source: 'upload', createdAt: '2026-01-01T00:00:00.000Z' },
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
    expect((sent as { byId: Record<string, unknown> }).byId['a-1']).toBeDefined()
  })
})

describe('tauriList：空库播种与示例升级', () => {
  it('首次（无项目文件）写入两个种子项目后重列', async () => {
    let listed = false
    handlers.set('list_projects', () => {
      if (listed) {
        return [meta('sample-wu-ye-chu-zu-che'), meta('sample-du-shi-qi-yuan'), meta('user-p1')]
      }
      listed = true
      return []
    })
    handlers.set('save_project', () => undefined)
    // 递归重列后的升级检查会读取示例文件：返回各自携带匹配 project.id 的
    // 干净 v1 信封 → 无需覆盖（id 与受信路径不一致会被 §11.1 受信 id 覆盖
    // 修复改写并触发回写）
    handlers.set('load_project', (args) => ({
      ...modernFile(),
      project: { ...modernFile().project, id: (args as { id: string }).id },
    }))
    const { projectStore } = await load()
    const list = await projectStore.list()
    expect(list.map((x) => x.id)).toEqual(['sample-wu-ye-chu-zu-che', 'sample-du-shi-qi-yuan', 'user-p1'])
    // 两个种子各写盘一次
    expect(calls.filter((c) => c.cmd === 'save_project')).toHaveLength(2)
    expect(list[0].updatedAt).toBe(UPDATED_ISO)
    expect(list[0].endingCount).toBe(2)
  })

  it('示例项目仍是旧格式但已被编辑：迁移回写用户内容，不用新种子覆盖', async () => {
    handlers.set('list_projects', () => [meta('sample-wu-ye-chu-zu-che'), meta('user-p1')])
    handlers.set('load_project', (args) => {
      const { id } = args as { id: string }
      if (id !== 'sample-wu-ye-chu-zu-che') throw new Error('不应读取用户项目')
      // 用户编辑过的示例（已改名，仍是 v0 旧扁平格式）
      return { ...legacyFile(), project: { ...legacyFile().project, id, name: '我的修改版' } }
    })
    handlers.set('save_project', () => undefined)
    const { projectStore } = await load()
    await projectStore.list()
    expect(calls.filter((c) => c.cmd === 'load_project')).toHaveLength(1)
    const saves = calls.filter((c) => c.cmd === 'save_project')
    expect(saves).toHaveLength(1)
    // 写回的是迁移后的用户内容，不是硬编码种子的「午夜出租车」
    const saved = (saves[0].args as { doc: { schemaVersion: number; project: { name: string } } }).doc
    expect(saved.schemaVersion).toBe(1)
    expect(saved.project.name).toBe('我的修改版')
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

  it('duplicate = load → create → copy_project_assets → save 全链路（副本名拼接）', async () => {
    handlers.set('load_project', () => modernFile())
    handlers.set('create_project', (args) => ({ ...meta('copy-1'), name: (args as { name: string }).name }))
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
      assets: { byId: { 'a-1': { id: 'a-1', relPath: 'assets/x.png', mime: 'image/png', source: 'upload', createdAt: '2026-01-01T00:00:00.000Z' } } },
    }))
    handlers.set('create_project', () => meta('copy-9'))
    handlers.set('copy_project_assets', () => undefined)
    handlers.set('save_project', () => undefined)
    const { projectStore } = await load()
    await projectStore.duplicate('p1')
    const copyCall = calls.find((c) => c.cmd === 'copy_project_assets')
    expect(copyCall?.args).toEqual({ fromId: 'p1', toId: 'copy-9' })
    const order = calls.map((c) => c.cmd)
    expect(order.indexOf('copy_project_assets')).toBeLessThan(order.indexOf('save_project'))
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
      await expect(projectStore.save('p1', { name: 'v1', nodes: [], edges: [], settings: { characters: [], locations: [] } })).rejects.toThrow('磁盘满')
      await vi.advanceTimersByTimeAsync(5000)
      await expect(projectStore.save('p1', { name: 'v2', nodes: [], edges: [], settings: { characters: [], locations: [] } })).rejects.toThrow('磁盘满')
      // 编辑器此时卸载：无组件持有文档——所有者仍按节律重试最新（v2）文档
      await vi.advanceTimersByTimeAsync(5000)
      await vi.advanceTimersByTimeAsync(5000)
      const saves = calls.filter((c) => c.cmd === 'save_project')
      expect(saves.length).toBeGreaterThanOrEqual(3)
      const last = saves[saves.length - 1].args as { doc: { project: { name: string } } }
      expect(last.doc.project.name).toBe('v2')
    } finally {
      vi.useRealTimers()
    }
  })

  it('同项目后续保存成功即清待重试：不重复落盘旧文档', async () => {
    let failFirst = true
    handlers.set('load_project', () => modernFile())
    handlers.set('save_project', () => {
      if (failFirst) {
        failFirst = false
        throw new Error('只读')
      }
      return undefined
    })
    vi.useFakeTimers()
    try {
      const { projectStore } = await load()
      await expect(projectStore.save('p1', { name: '旧', nodes: [], edges: [], settings: { characters: [], locations: [] } })).rejects.toThrow('只读')
      // 恢复后新会话手动保存更新文档（成功）——待重试登记被清除
      await projectStore.save('p1', { name: '新', nodes: [], edges: [], settings: { characters: [], locations: [] } })
      await vi.advanceTimersByTimeAsync(20000)
      const names = calls
        .filter((c) => c.cmd === 'save_project')
        .map((c) => (c.args as { doc: { project: { name: string } } }).doc.project.name)
      expect(names).toEqual(['旧', '新'])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('持久化所有者的代次与删除串行（陈旧重试/复活防护）', () => {
  it('陈旧代次的重试作废：新保存排队后，旧文档的重试不得覆盖新内容', async () => {
    let aFailed = false
    let releaseB: (() => void) | null = null
    handlers.set('load_project', () => modernFile())
    handlers.set('save_project', (args) =>
      new Promise<void>((resolve, reject) => {
        const name = (args as { doc: { project: { name: string } } }).doc.project.name
        if (name === '旧') {
          if (!aFailed) {
            aFailed = true
            reject(new Error('瞬时故障'))
            return
          }
          resolve() // 重试若被放行会成功——正是要证明它不该跑
          return
        }
        releaseB = resolve // 新文档挂起（在途超过重试周期）
      }),
    )
    vi.useFakeTimers()
    try {
      const { projectStore } = await load()
      await expect(projectStore.save('p1', { name: '旧', nodes: [], edges: [], settings: { characters: [], locations: [] } })).rejects.toThrow('瞬时故障')
      const savingB = projectStore.save('p1', { name: '新', nodes: [], edges: [], settings: { characters: [], locations: [] } })
      await vi.advanceTimersByTimeAsync(5000) // 重试到点：须因新保存已排队而作废
      ;(releaseB as unknown as (() => void) | undefined)?.()
      await savingB
      await vi.advanceTimersByTimeAsync(20000)
      const names = calls
        .filter((c) => c.cmd === 'save_project')
        .map((c) => (c.args as { doc: { project: { name: string } } }).doc.project.name)
      expect(names).toEqual(['旧', '新'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('删除排在在途保存之后：保存完成前不得发出 delete_project', async () => {
    let releaseSave: (() => void) | null = null
    handlers.set('load_project', () => modernFile())
    handlers.set('save_project', () => new Promise<void>((resolve) => { releaseSave = resolve }))
    handlers.set('delete_project', () => undefined)
    const { projectStore } = await load()
    const saving = projectStore.save('p1', { name: 'x', nodes: [], edges: [], settings: { characters: [], locations: [] } })
    const deleting = projectStore.delete('p1')
    // 等保存真正挂起（invoke 链有多跳微任务），删除此时不得越过它
    await vi.waitFor(() => expect(releaseSave).not.toBeNull())
    expect(calls.some((c) => c.cmd === 'delete_project')).toBe(false) // 红：未串行即提前发出
    ;(releaseSave as unknown as (() => void) | undefined)?.()
    await saving
    await deleting
    expect(calls.some((c) => c.cmd === 'delete_project')).toBe(true)
  })

  it('删除取消重试状态：已删项目不被登记中的重试复活', async () => {
    handlers.set('load_project', () => modernFile())
    handlers.set('save_project', () => {
      throw new Error('只读')
    })
    handlers.set('delete_project', () => undefined)
    vi.useFakeTimers()
    try {
      const { projectStore } = await load()
      await expect(projectStore.save('p1', { name: 'x', nodes: [], edges: [], settings: { characters: [], locations: [] } })).rejects.toThrow('只读')
      await projectStore.delete('p1')
      await vi.advanceTimersByTimeAsync(20000)
      expect(calls.filter((c) => c.cmd === 'save_project')).toHaveLength(1) // 红：重试复活
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('持久化所有者的代次重排与删除墓碑', () => {
  const docOf = (name: string) => ({ name, nodes: [], edges: [], settings: { characters: [], locations: [] } })

  it('新代次失败须接管重试定时器：最新失败文档最终落盘', async () => {
    handlers.set('load_project', () => modernFile())
    handlers.set('save_project', () => {
      throw new Error('只读')
    })
    vi.useFakeTimers()
    try {
      const { projectStore } = await load()
      await expect(projectStore.save('p1', docOf('旧'))).rejects.toThrow('只读')
      await expect(projectStore.save('p1', docOf('新'))).rejects.toThrow('只读')
      // 红：A 的旧定时器触发即自灭，B 的登记无人重试
      await vi.advanceTimersByTimeAsync(5000)
      const names = calls
        .filter((c) => c.cmd === 'save_project')
        .map((c) => (c.args as { doc: { project: { name: string } } }).doc.project.name)
      expect(names).toEqual(['旧', '新', '新']) // 重试以最新文档发起
    } finally {
      vi.useRealTimers()
    }
  })

  it('删除开始后的保存排队被吸收：不复活已删项目', async () => {
    let releaseA: (() => void) | null = null
    handlers.set('load_project', () => modernFile())
    handlers.set('save_project', () =>
      new Promise<void>((resolve) => {
        if (releaseA !== null) {
          resolve() // 首次之后的保存立即完成：红态下 B 复活项目即被断言抓住
          return
        }
        releaseA = resolve
      }),
    )
    handlers.set('delete_project', () => undefined)
    const { projectStore } = await load()
    const savingA = projectStore.save('p1', docOf('A'))
    const deleting = projectStore.delete('p1')
    await vi.waitFor(() => expect(releaseA).not.toBeNull())
    ;(releaseA as unknown as () => void)()
    await savingA
    // 编辑器卸载后的合并冲刷（B）在 A 完成后才排队：不得复活已删项目
    await projectStore.save('p1', docOf('B'))
    await deleting
    expect(calls.filter((c) => c.cmd === 'save_project')).toHaveLength(1)
    expect(calls.some((c) => c.cmd === 'delete_project')).toBe(true)
  })

  it('删除失败时回吐删除期间吸收的最新文档重存：迟到编辑不落空', async () => {
    let rejectDelete: ((err: Error) => void) | null = null
    handlers.set('load_project', () => modernFile())
    handlers.set('save_project', () => undefined)
    handlers.set('delete_project', () =>
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
        .map((c) => (c.args as { doc: { project: { name: string } } }).doc.project.name)
      expect(names).toEqual(['新迟到']) // 只回吐最新一份
    })
  })

  it('删除失败回吐删除前已登记重试的文档：墓碑清除不丢最新编辑', async () => {
    let failed = false
    handlers.set('load_project', () => modernFile())
    handlers.set('save_project', () => {
      if (!failed) {
        failed = true
        throw new Error('磁盘满')
      }
      return undefined
    })
    handlers.set('delete_project', () => {
      throw new Error('占用')
    })
    const { projectStore } = await load()
    await expect(projectStore.save('p1', docOf('Z'))).rejects.toThrow('磁盘满')
    await expect(projectStore.delete('p1')).rejects.toThrow('占用')
    // 红：重试登记被删除开场的 clearSaveRetry 摘除——项目仍在磁盘，
    // 最新编辑（编辑器已卸载时只存于登记）既没落盘也无重试
    await vi.waitFor(() => {
      const names = calls
        .filter((c) => c.cmd === 'save_project')
        .map((c) => (c.args as { doc: { project: { name: string } } }).doc.project.name)
      expect(names).toEqual(['Z', 'Z'])
    })
  })

  it('删除失败回吐墓碑前在途保存失败登记的重试文档（评审场景）', async () => {
    let rejectA: ((err: Error) => void) | null = null
    handlers.set('load_project', () => modernFile())
    handlers.set('save_project', () => {
      if (rejectA === null) {
        // 保存 A 在删除排队期间落定失败：登记重试后即被删除链二次清除
        return new Promise<void>((_resolve, reject) => {
          rejectA = reject
        })
      }
      return Promise.resolve() // 回吐重存成功
    })
    handlers.set('delete_project', () => {
      throw new Error('占用')
    })
    const { projectStore } = await load()
    const savingA = projectStore.save('p1', docOf('A'))
    const deleting = projectStore.delete('p1')
    await vi.waitFor(() => expect(rejectA).not.toBeNull())
    ;(rejectA as unknown as (e: Error) => void)(new Error('磁盘满'))
    await expect(savingA).rejects.toThrow('磁盘满')
    await expect(deleting).rejects.toThrow('占用')
    // 红：A 排队于墓碑之前未被吸收，二次 clearSaveRetry 丢弃登记后删除又失败
    // ——项目仍在磁盘，最新编辑永远无人重试
    await vi.waitFor(() => {
      const names = calls
        .filter((c) => c.cmd === 'save_project')
        .map((c) => (c.args as { doc: { project: { name: string } } }).doc.project.name)
      expect(names).toEqual(['A', 'A'])
    })
  })

  it('删除失败不回吐已被后续成功保存取代的登记文档（陈旧重试不得覆盖新内容）', async () => {
    let failFirst = true
    handlers.set('load_project', () => modernFile())
    handlers.set('save_project', () => {
      if (failFirst) {
        failFirst = false
        throw new Error('磁盘满')
      }
      return undefined
    })
    handlers.set('delete_project', () => {
      throw new Error('占用')
    })
    vi.useFakeTimers()
    try {
      const { projectStore } = await load()
      await expect(projectStore.save('p1', docOf('旧A'))).rejects.toThrow('磁盘满')
      // B 排在 A 之后、删除排队时仍在途：B 成功即取代 A 的重试登记
      const savingB = projectStore.save('p1', docOf('新B'))
      const deleting = projectStore.delete('p1')
      await savingB
      await expect(deleting).rejects.toThrow('占用')
      // 红：回吐捕获的 A 登记会把旧文档重放覆盖已成功落盘的 B
      await vi.advanceTimersByTimeAsync(20000)
      const names = calls
        .filter((c) => c.cmd === 'save_project')
        .map((c) => (c.args as { doc: { project: { name: string } } }).doc.project.name)
      expect(names).toEqual(['旧A', '新B'])
    } finally {
      vi.useRealTimers()
    }
  })
})
