import { describe, expect, it } from 'vitest'
import { libraryStore, LIBRARY_KINDS, type LibraryAsset } from './libraryStore'

/** 浏览器预览的内存回退实现（无 IPC）：put/list/updateMeta/remove/mediaUrl。
 * 模块级 memoryAssets 跨用例共享，各用例断言只针对自己放入的条目。 */

const file = (name: string, content: string, mime = ''): File =>
  new File([content], name, { type: mime })

async function putSample(name = '参考图.png', mime = 'image/png'): Promise<LibraryAsset> {
  return libraryStore.put(file(name, 'binary…', mime), 'reference')
}

describe('libraryStore 内存回退：put/list', () => {
  it('put 生成 local-la 前缀 id，字段齐备且出现在 list 中', async () => {
    const asset = await putSample()
    expect(asset.id.startsWith('local-la-')).toBe(true)
    expect(asset).toMatchObject({
      name: '参考图.png',
      kind: 'reference',
      view: null,
      relPath: '',
      tags: [],
      groupId: null,
    })
    expect(asset.createdAt).toBeGreaterThan(0)
    const all = await libraryStore.list()
    expect(all.some((a) => a.id === asset.id)).toBe(true)
  })

  it('空 MIME 回退 application/octet-stream', async () => {
    const asset = await putSample('无类型.bin', '')
    expect(asset.mime).toBe('application/octet-stream')
  })

  it('不同 kind 均可入库（与 LIBRARY_KINDS 清单一致）', async () => {
    for (const { kind } of LIBRARY_KINDS) {
      const a = await libraryStore.put(file(`${kind}.png`, 'x', 'image/png'), kind)
      expect(a.kind).toBe(kind)
    }
  })
})

describe('libraryStore 内存回退：updateMeta', () => {
  it('改名/打标签/编组/视角合并到既有条目', async () => {
    const asset = await putSample()
    const updated = await libraryStore.updateMeta(asset.id, {
      name: '氛围图.png',
      tags: ['夜景', '天台'],
      groupId: 'g1',
      view: 'front',
    })
    expect(updated).toMatchObject({
      id: asset.id,
      name: '氛围图.png',
      tags: ['夜景', '天台'],
      groupId: 'g1',
      view: 'front',
    })
    const all = await libraryStore.list()
    expect(all.find((a) => a.id === asset.id)?.name).toBe('氛围图.png')
  })

  it('部分补丁只改给出的字段', async () => {
    const asset = await putSample()
    const updated = await libraryStore.updateMeta(asset.id, { name: '改名.png' })
    expect(updated.name).toBe('改名.png')
    expect(updated.tags).toEqual([])
  })

  it('不存在的 id 拒绝更新', async () => {
    await expect(libraryStore.updateMeta('local-la-ghost', { name: 'x' })).rejects.toThrow(
      /不存在/,
    )
  })
})

describe('libraryStore 内存回退：remove', () => {
  it('删除后 list 不再出现，且幂等', async () => {
    const asset = await putSample('待删.png')
    await libraryStore.remove(asset.id)
    const after = await libraryStore.list()
    expect(after.some((a) => a.id === asset.id)).toBe(false)
    await expect(libraryStore.remove(asset.id)).resolves.toBeUndefined()
  })
})

describe('libraryStore 内存回退：mediaUrl', () => {
  it('返回 blob: object URL；已删除条目拒绝', async () => {
    const asset = await putSample('媒体.png')
    const url = await libraryStore.mediaUrl(asset)
    expect(url.startsWith('blob:')).toBe(true)
    await libraryStore.remove(asset.id)
    await expect(libraryStore.mediaUrl(asset)).rejects.toThrow(/不存在/)
  })
})
