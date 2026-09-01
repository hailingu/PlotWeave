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
  settings: { characters: {}, locations: {}, props: {} },
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
    const { projectStore } = await load()
    const doc = await projectStore.load('p1')
    expect(doc.episodeTitles).toEqual({ 1: '开局' })
    // 新 schema 不回写；加载侧资产复验固定先行
    expect(calls.map((c) => c.cmd)).toEqual(['load_project', 'verify_project_assets'])
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

  it('迁移回写失败：内存副本照常交付，显式诊断且不留未处理拒绝', async () => {
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
          errSpy.mock.calls.some((c) => String(c[0]).includes('迁移回写')),
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
    // 递归重列后的升级检查会读取示例文件：返回 v1 信封 → 无需覆盖
    handlers.set('load_project', () => modernFile())
    const { projectStore } = await load()
    const list = await projectStore.list()
    expect(list.map((x) => x.id)).toEqual(['sample-wu-ye-chu-zu-che', 'sample-du-shi-qi-yuan', 'user-p1'])
    // 两个种子各写盘一次
    expect(calls.filter((c) => c.cmd === 'save_project')).toHaveLength(2)
    expect(list[0].updatedAt).toBe(UPDATED_ISO)
    expect(list[0].endingCount).toBe(2)
  })

  it('示例项目仍是旧格式时覆盖新种子；用户项目不读取不覆盖', async () => {
    handlers.set('list_projects', () => [meta('sample-wu-ye-chu-zu-che'), meta('user-p1')])
    handlers.set('load_project', (args) => {
      const { id } = args as { id: string }
      if (id !== 'sample-wu-ye-chu-zu-che') throw new Error('不应读取用户项目')
      return { ...legacyFile(), project: { ...legacyFile().project, id, name: '旧示例' } }
    })
    handlers.set('save_project', () => undefined)
    const { projectStore } = await load()
    await projectStore.list()
    expect(calls.filter((c) => c.cmd === 'load_project')).toHaveLength(1)
    expect(calls.filter((c) => c.cmd === 'save_project')).toHaveLength(1)
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
    handlers.set('save_project', () => {
      throw new Error('资产 a-1：资产文件不存在：assets/x.png')
    })
    handlers.set('delete_project', () => {
      throw new Error('目录只读，删不掉')
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { projectStore } = await load()
      await expect(projectStore.duplicate('p1')).rejects.toThrow(/copy-y/)
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
