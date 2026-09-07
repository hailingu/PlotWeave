import { describe, expect, it, vi } from 'vitest'
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
    // createdAt 为 §7.2 UTC ISO 字符串（内存回退用 toISOString 生成）
    expect(typeof asset.createdAt).toBe('string')
    expect(Number.isNaN(Date.parse(asset.createdAt))).toBe(false)
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

// ---- 组命令门面（issue #29 PR 2，§7.2）----

describe('组命令门面', () => {
  it('upsertGroup 新建/更新组', async () => {
    const g = await libraryStore.upsertGroup({ id: 'g-1', name: '女主', kind: 'character' })
    expect(g).toEqual({ id: 'g-1', name: '女主', kind: 'character' })
    const groups = await libraryStore.listGroups()
    expect(groups).toContainEqual(g)
  })

  it('deleteGroup 删除组并剥离成员 groupId', async () => {
    const asset = await libraryStore.put(
      new File([new Uint8Array([1])], 'a.png', { type: 'image/png' }),
      'character',
    )
    await libraryStore.updateMeta(asset.id, { groupId: 'g-1' })
    await libraryStore.upsertGroup({ id: 'g-1', name: '女主', kind: 'character' })
    await libraryStore.deleteGroup('g-1')
    const groups = await libraryStore.listGroups()
    expect(groups).toHaveLength(0)
    const after = await libraryStore.list()
    expect(after.find((a) => a.id === asset.id)?.groupId).toBeNull()
  })

  it('listGroups 在空库返回空数组', async () => {
    await expect(libraryStore.listGroups()).resolves.toEqual([])
  })
})

// ---- 内存回退与生产路径同语义（评审修复，PR #36 第一轮）----

describe('内存回退组语义与生产路径一致', () => {
  it('upsertGroup 改 kind 与成员冲突即拒绝', async () => {
    const asset = await libraryStore.put(
      new File([new Uint8Array([1])], 'a.png', { type: 'image/png' }),
      'character',
    )
    await libraryStore.updateMeta(asset.id, { groupId: 'g-1' })
    await libraryStore.upsertGroup({ id: 'g-1', name: '女主', kind: 'character' })
    // 改 kind 与成员冲突
    await expect(
      libraryStore.upsertGroup({ id: 'g-1', name: '女主', kind: 'location' }),
    ).rejects.toThrow(/冲突|kind/)
  })

  it('deleteGroup 不存在的组拒绝', async () => {
    await expect(libraryStore.deleteGroup('g-ghost')).rejects.toThrow(/不存在/)
  })
})

/// 内存回退首次创建也做冲突扫描（评审修复，PR #36 第二轮）：updateMeta 先
/// 挂悬空 groupId，再 upsert 新建组时 kind 不一致不得被放行——首次创建
/// （existing 为 undefined）也要扫描成员。需独立模块实例隔离内存状态（模块
/// 级 Map 跨用例共享，否则前面用例的组残留会让 existing 非空、测试假阳性）。
describe('内存回退首次创建组语义', () => {
  it('upsertGroup 首次创建时 kind 与既有成员冲突即拒绝', async () => {
    vi.resetModules()
    const { libraryStore: fresh } = await import('./libraryStore')
    const asset = await fresh.put(
      new File([new Uint8Array([1])], 'a.png', { type: 'image/png' }),
      'character',
    )
    await fresh.updateMeta(asset.id, { groupId: 'g-1' }) // 悬空 groupId
    // 首次创建组，kind 与既有成员不一致
    await expect(
      fresh.upsertGroup({ id: 'g-1', name: '女主', kind: 'location' }),
    ).rejects.toThrow(/冲突|kind/)
  })
})

/// 内存回退组形状校验与生产同款（评审修复，PR #36 第三轮）：name 去空白
/// 1–128、kind 在声明联合内、id 非空——合法 name 存 trim 后的值，非法拒绝。
describe('内存回退组形状校验', () => {
  it('upsertGroup trim 合法 name 并拒绝非法形状', async () => {
    const g = await libraryStore.upsertGroup({ id: 'g-t', name: '  女主  ', kind: 'character' })
    expect(g.name).toBe('女主')
    await expect(
      libraryStore.upsertGroup({ id: 'g-x', name: '   ', kind: 'character' }),
    ).rejects.toThrow(/name|空白/)
    await expect(
      libraryStore.upsertGroup({ id: 'g-x', name: 'x'.repeat(129), kind: 'character' }),
    ).rejects.toThrow(/name|128/)
    await expect(
      libraryStore.upsertGroup({ id: 'g-x', name: 'x', kind: 'robot' as never }),
    ).rejects.toThrow(/kind/)
  })
})

/// 内存回退 id 校验与生产同款（评审修复，PR #36 第四轮）：镜像 Rust
/// validate_asset_id——1–64 ASCII 字母数字/_/-；空白填充、路径段、超长
/// 一律拒绝。
describe('内存回退组 id 校验', () => {
  it('upsertGroup 拒绝不在生产 id 值域内的 id', async () => {
    for (const id of [' g ', '../g', 'g'.repeat(65), 'g/1', 'g.1']) {
      await expect(libraryStore.upsertGroup({ id, name: 'x', kind: 'character' })).rejects.toThrow(
        /id/,
      )
    }
    // 合法形态仍通过
    await expect(
      libraryStore.upsertGroup({ id: 'g_1-A', name: 'x', kind: 'character' }),
    ).resolves.toMatchObject({ id: 'g_1-A' })
  })
})
