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
    // updateMeta 挂 groupId 须组已存在且 kind 一致（评审修复，PR #36 第五轮）
    await libraryStore.upsertGroup({ id: 'g1', name: '参考组', kind: 'reference' })
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
    // 独立模块实例：模块级 Map 跨用例共享，前面用例的组会残留本用例的
    // listGroups 断言（评审修复 PR #36 第五轮的连锁调整）
    vi.resetModules()
    const { libraryStore: fresh } = await import('./libraryStore')
    const asset = await fresh.put(
      new File([new Uint8Array([1])], 'a.png', { type: 'image/png' }),
      'character',
    )
    await fresh.upsertGroup({ id: 'g-1', name: '女主', kind: 'character' })
    await fresh.updateMeta(asset.id, { groupId: 'g-1' })
    await fresh.deleteGroup('g-1')
    const groups = await fresh.listGroups()
    expect(groups).toHaveLength(0)
    const after = await fresh.list()
    expect(after.find((a) => a.id === asset.id)?.groupId).toBeNull()
  })

  it('listGroups 在空库返回空数组', async () => {
    vi.resetModules()
    const { libraryStore: fresh } = await import('./libraryStore')
    await expect(fresh.listGroups()).resolves.toEqual([])
  })
})

// ---- 内存回退与生产路径同语义（评审修复，PR #36 第一轮）----

describe('内存回退组语义与生产路径一致', () => {
  it('upsertGroup 改 kind 与成员冲突即拒绝', async () => {
    const asset = await libraryStore.put(
      new File([new Uint8Array([1])], 'a.png', { type: 'image/png' }),
      'character',
    )
    // 先建同 kind 组再挂成员（updateMeta 拒绝悬空/不一致 groupId，评审修复
    // PR #36 第五轮），随后改组 kind 触发成员冲突
    await libraryStore.upsertGroup({ id: 'g-1', name: '女主', kind: 'character' })
    await libraryStore.updateMeta(asset.id, { groupId: 'g-1' })
    await expect(
      libraryStore.upsertGroup({ id: 'g-1', name: '女主', kind: 'location' }),
    ).rejects.toThrow(/冲突|kind/)
  })

  it('deleteGroup 不存在的组拒绝', async () => {
    await expect(libraryStore.deleteGroup('g-ghost')).rejects.toThrow(/不存在/)
  })
})

/// upsert 侧的无条件成员扫描保留为纵深防御（评审修复，PR #36 第二轮）：
/// 第五轮后 updateMeta 已拒绝悬空/不一致 groupId，「首次创建前挂悬空引用」
/// 在内存回退不可达，但扫描仍须在首次创建与改 kind 两路径都生效——本测试
/// 用独立模块实例验证组已存在场景下的扫描（与改 kind 测试互补：先建组、
/// 挂成员，再以不一致 kind 重建同 id 组）。
describe('内存回退首次创建组语义', () => {
  it('upsertGroup 首次创建时 kind 与既有成员冲突即拒绝', async () => {
    vi.resetModules()
    const { libraryStore: fresh } = await import('./libraryStore')
    const asset = await fresh.put(
      new File([new Uint8Array([1])], 'a.png', { type: 'image/png' }),
      'character',
    )
    // 第五轮修复：悬空 groupId 在 updateMeta 即拒绝（不再可建立）
    await expect(fresh.updateMeta(asset.id, { groupId: 'g-1' })).rejects.toThrow(/不存在/)
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

/// 内存回退 updateMeta 挂 groupId 时校验（评审修复，PR #36 第五轮）：组不
/// 存在或 kind 不一致即拒绝——与 Rust update_meta_with 的复验同语义；null
/// 清除标记不受限。
describe('内存回退 updateMeta 的 groupId 校验', () => {
  it('拒绝不存在的组与 kind 不一致的组，null 清除放行', async () => {
    vi.resetModules()
    const { libraryStore: fresh } = await import('./libraryStore')
    const loc = await fresh.put(
      new File([new Uint8Array([1])], 'l.png', { type: 'image/png' }),
      'location',
    )
    await fresh.upsertGroup({ id: 'g-loc', name: '场景组', kind: 'location' })
    await fresh.upsertGroup({ id: 'g-char', name: '角色组', kind: 'character' })
    // 组不存在
    await expect(fresh.updateMeta(loc.id, { groupId: 'g-ghost' })).rejects.toThrow(/不存在/)
    // kind 不一致
    await expect(fresh.updateMeta(loc.id, { groupId: 'g-char' })).rejects.toThrow(/kind|冲突/)
    // 一致的组放行
    await fresh.updateMeta(loc.id, { groupId: 'g-loc' })
    expect((await fresh.list()).find((a) => a.id === loc.id)?.groupId).toBe('g-loc')
    // null 清除放行
    await fresh.updateMeta(loc.id, { groupId: null })
    expect((await fresh.list()).find((a) => a.id === loc.id)?.groupId).toBeNull()
  })
})

/// 内存回退组与调用方对象隔离（评审修复，PR #36 第六轮）：存储与返回克隆
/// ——调用方 mutate 传入/返回的对象不得绕过校验直接改 memoryGroups。
describe('内存回退组对象隔离', () => {
  it('mutate 传入/返回/listGroups 的对象不影响存储', async () => {
    const g = await libraryStore.upsertGroup({ id: 'g-iso', name: '女主', kind: 'character' })
    const member = await libraryStore.put(
      new File([new Uint8Array([1])], 'a.png', { type: 'image/png' }),
      'character',
    )
    await libraryStore.updateMeta(member.id, { groupId: 'g-iso' })
    // mutate 传入的引用
    g.name = '被改'
    // mutate upsert 返回的引用
    const again = await libraryStore.upsertGroup({ id: 'g-iso', name: '女主', kind: 'character' })
    again.kind = 'location'
    // mutate listGroups 返回的引用
    const listed = await libraryStore.listGroups()
    const listedG = listed.find((x) => x.id === 'g-iso')
    listedG!.kind = 'location'
    // 存储中的组不受影响：成员仍同 kind 一致
    const after = (await libraryStore.listGroups()).find((x) => x.id === 'g-iso')
    expect(after).toEqual({ id: 'g-iso', name: '女主', kind: 'character' })
  })
})

/// 内存回退空串 groupId 与 name 字符计数（评审修复，PR #36 第八轮）：
/// 空串与空白同归清除（Rust apply_group_id 同款）；name 按 Unicode 码点
/// 计数（Rust chars().count() 同款），补充字符不超 128 应放行。
describe('内存回退清除标记与字符计数', () => {
  it('updateMeta 空串 groupId 归清除不留空串', async () => {
    const asset = await libraryStore.put(
      new File([new Uint8Array([1])], 'a.png', { type: 'image/png' }),
      'character',
    )
    await libraryStore.upsertGroup({ id: 'g-1', name: '女主', kind: 'character' })
    await libraryStore.updateMeta(asset.id, { groupId: 'g-1' })
    // 空串同 null：清除
    await libraryStore.updateMeta(asset.id, { groupId: '' })
    const after = (await libraryStore.list()).find((a) => a.id === asset.id)
    expect(after?.groupId).toBeNull()
  })

  it('upsertGroup name 按 Unicode 码点计数', async () => {
    vi.resetModules()
    const { libraryStore: fresh } = await import('./libraryStore')
    const name = '🙂'.repeat(100) // 100 码点（200 UTF-16 单元）
    const g = await fresh.upsertGroup({ id: 'g-emoji', name, kind: 'character' })
    expect(g.name).toBe(name)
    // 129 码点应拒绝
    await expect(
      fresh.upsertGroup({ id: 'g-over', name: '🙂'.repeat(129), kind: 'character' }),
    ).rejects.toThrow(/128/)
  })
})

/// 内存回退资产与调用方对象隔离（评审修复，PR #36 第九轮）：存储与返回
/// 克隆——调用方 mutate list/updateMeta 返回的资产不得绕过组校验直接改
/// memoryAssets；mutate Tauri 响应不影响持久化状态，预览同款。
describe('内存回退资产对象隔离', () => {
  it('mutate list/updateMeta 返回的资产不影响存储', async () => {
    vi.resetModules()
    const { libraryStore: fresh } = await import('./libraryStore')
    const asset = await fresh.put(
      new File([new Uint8Array([1])], 'a.png', { type: 'image/png' }),
      'character',
    )
    await fresh.upsertGroup({ id: 'g-1', name: '女主', kind: 'character' })
    await fresh.updateMeta(asset.id, { groupId: 'g-1' })
    // mutate list 返回的引用
    const listed = (await fresh.list()).find((a) => a.id === asset.id)!
    listed.kind = 'location' as never
    listed.groupId = 'g-ghost'
    // mutate updateMeta 返回的引用
    const updated = await fresh.updateMeta(asset.id, { name: 'x' })
    updated.kind = 'location' as never
    // 存储不受影响
    const after = (await fresh.list()).find((a) => a.id === asset.id)!
    expect(after.kind).toBe('character')
    expect(after.groupId).toBe('g-1')
    // 组校验仍对存储生效：mutate 后挂不一致组仍被拒
    await expect(fresh.updateMeta(asset.id, { groupId: 'g-ghost' })).rejects.toThrow(/不存在/)
  })
})
