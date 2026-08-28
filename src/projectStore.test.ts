import { describe, expect, it, vi } from 'vitest'
import { projectStore, type ProjectContent } from './projectStore'
import type { CanvasNode } from './editor/nodes/types'

const node = (n: CanvasNode): CanvasNode => n

describe('projectStore 内存门面（浏览器回退）', () => {
  it('list 首次返回两个种子项目，按更新时间倒序', async () => {
    const list = await projectStore.list()
    expect(list.map((x) => x.id)).toEqual(['sample-du-shi-qi-yuan', 'sample-wu-ye-chu-zu-che'])
    expect(list[0].name).toBe('都市奇缘')
  })

  it('冻结时钟下连续 create 的 id 仍互不相同（同毫秒防静默覆盖）', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-28T12:00:00Z'))
    try {
      const a = await projectStore.create('甲')
      const b = await projectStore.create('乙')
      expect(a.id).not.toBe(b.id)
    } finally {
      vi.useRealTimers()
    }
  })

  it('create → save → load 全链路：local- 前缀 id，文档经深拷贝往返', async () => {
    const meta = await projectStore.create('测试剧')
    expect(meta.id.startsWith('local-')).toBe(true)
    expect(meta.sceneCount).toBe(0)

    const doc: ProjectContent = {
      name: '测试剧',
      nodes: [],
      edges: [],
      settings: { characters: [], locations: [] },
      episodeTitles: { 1: '开局' },
    }
    await projectStore.save(meta.id, doc)
    const loaded = await projectStore.load(meta.id)
    expect(loaded.episodeTitles).toEqual({ 1: '开局' })
    // load 返回深拷贝：改动不影响存档
    loaded.episodeTitles![1] = '改了'
    expect((await projectStore.load(meta.id)).episodeTitles).toEqual({ 1: '开局' })
  })

  it('load 不存在的 id 抛错；delete 后消失；duplicate 产出「副本」', async () => {
    await expect(projectStore.load('ghost')).rejects.toThrow(/不存在/)
    const meta = await projectStore.create('原剧')
    await projectStore.save(meta.id, { name: '原剧', nodes: [], edges: [], settings: { characters: [], locations: [] } })
    const copy = await projectStore.duplicate(meta.id)
    expect(copy.name).toBe('原剧 副本')
    await projectStore.delete(meta.id)
    await expect(projectStore.load(meta.id)).rejects.toThrow(/不存在/)
    // 副本仍在
    const copyDoc = await projectStore.load(copy.id)
    expect(copyDoc.name).toBe('原剧 副本')
  })

  it('duplicate：副本创建时间是新的，且不携带源资产索引（§7.3 复制不指向源项目文件）', async () => {
    const meta = await projectStore.create('原剧')
    await projectStore.save(meta.id, {
      name: '原剧',
      createdAt: '2026-01-01T00:00:00.000Z',
      nodes: [],
      edges: [],
      settings: { characters: [], locations: [] },
      assets: { byId: { 'a-1': { id: 'a-1', relPath: 'assets/x.png', mime: 'image/png', source: 'upload', createdAt: '' } } },
    })
    const copy = await projectStore.duplicate(meta.id)
    const copyDoc = await projectStore.load(copy.id)
    expect(copyDoc.createdAt).not.toBe('2026-01-01T00:00:00.000Z')
    // relPath 相对源项目目录：复制不带索引，避免悬空文件引用
    expect(copyDoc.assets).toBeUndefined()
    // 源项目自己的索引不受影响
    const srcDoc = await projectStore.load(meta.id)
    expect(srcDoc.assets?.byId['a-1']).toBeDefined()
  })

  it('saveQuiet 吞掉异常不打断调用方', async () => {
    await expect(
      projectStore.saveQuiet('ghost-id-不校验', { name: 'x', nodes: [], edges: [], settings: { characters: [], locations: [] } }),
    ).resolves.toBeUndefined()
  })

  it('list 的 endingCount 由「无出边场景数」派发（>1 才携带）', async () => {
    const meta = await projectStore.create('双结局剧')
    const sceneNoOut = (id: string, no: number) =>
      node({ id, type: 'scene', position: { x: no, y: 0 }, selected: false, data: { name: `场${no}`, sceneNo: no, interior: true, time: '🌙 夜', synopsis: '', characterIds: [] } } as unknown as CanvasNode)
    await projectStore.save(meta.id, {
      name: '双结局剧',
      nodes: [sceneNoOut('a', 1), sceneNoOut('b', 2), sceneNoOut('c', 3)],
      edges: [{ id: 'e1', source: 'a', target: 'b' }],
      settings: { characters: [], locations: [] },
    })
    const me = (await projectStore.list()).find((x) => x.id === meta.id)
    expect(me?.endingCount).toBe(2) // b、c 无出边
  })
})
