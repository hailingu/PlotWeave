/**
 * 项目持久化的 Tauri 命令域（issue #39 自 projectStore.ts 拆出）：列表/新建/
 * 加载走 Rust 命令（JSON 文件落盘于应用数据目录）。加载为「单循环三段」
 * ——链静止 → 失败登记复验 → 磁盘读取（链身份守卫），保证「读到即最新」；
 * 空库播种与已知示例的旧格式升级回写也在此域。
 */
import { parseProject } from '../model/convert'
import type { ProjectContent } from '../model/content'
import { memoryNormalize } from './memory'
import {
  enqueueSave,
  pendingRetryDocs,
  saveChains,
  tauriSave,
  waitForSaveChainIdle,
} from './saveChain'
import { seedProjects } from './seeds'
import type { ProjectSummary } from '../home/projects'

/** Rust ProjectMeta → 首页 ProjectSummary；updated_at 为 ISO 字符串。
 * 非法时间戳（空串/坏格式）回退 epoch，绝不让 new Date 抛错清空首页列表。 */
function toSummary(m: {
  id: string
  name: string
  updated_at: string
  scene_count: number
  ending_count: number
}): ProjectSummary {
  const t = Date.parse(m.updated_at)
  return {
    id: m.id,
    name: m.name,
    sceneCount: m.scene_count,
    ...(m.ending_count > 1 ? { endingCount: m.ending_count } : {}),
    updatedAt: new Date(Number.isFinite(t) ? t : 0).toISOString(),
  }
}

/** 首次启动（无任何项目文件）时写入种子示例。metas 为空不证明目录为空：
 * list_project_metas 会跳过损坏/不可读文件——唯一项目若是 JSON 损坏的已
 * 编辑示例，无条件播种会用硬编码种子原子覆盖可能可恢复的用户文件。
 * 播种为 no-replace 语义：仅当 load_project 确证「项目不存在」才写种子，
 * 文件存在（含不可读）一律跳过并留痕。返回是否写入了任一种子。 */
async function seedFirstRun(): Promise<boolean> {
  const { invoke } = await import('@tauri-apps/api/core')
  const notFound = (e: unknown) =>
    (typeof e === 'string' || e instanceof Error) && String(e).includes('项目不存在')
  let seeded = false
  for (const seed of seedProjects()) {
    try {
      await invoke<unknown>('load_project', { id: seed.meta.id })
      console.warn('[projectStore] 播种跳过：项目已存在', seed.meta.id)
    } catch (err) {
      if (!notFound(err)) {
        console.warn('[projectStore] 播种跳过：项目文件不可读，不覆盖可能可恢复的内容', seed.meta.id, err)
        continue
      }
      await tauriSave(seed.meta.id, seed.doc)
      seeded = true
    }
  }
  return seeded
}

/** 已知示例的旧格式（schemaVersion 0）迁移与 v1 修复型归一化回写：写回
 * **迁移/修复后的用户内容**——示例可能已被编辑（改名/加场景/资产），用
 * 硬编码种子覆盖会在升级后首次打开首页时静默摧毁这些编辑；演示内容刷新
 * 只经由空库播种路径发生。与 tauriLoad 同款加载侧资产复验（§7.1/§10.5）：
 * 索引资产文件缺失/被换链接时先隔离再回写，回写不被保存边界拒收。
 * 单例隔离：该示例升级检查失败（如未来版本 schemaVersion——Rust 列表与
 * 信封仍返回、parseProject 才拒绝）只跳过该例并留痕，摘要原样保留，版本
 * 错误延迟到该项目被打开时呈现。返回是否发生回写。 */
async function upgradeKnownSamples(metas: { id: string }[]): Promise<boolean> {
  const { invoke } = await import('@tauri-apps/api/core')
  let repairedAny = false
  for (const meta of metas) {
    if (!meta.id.startsWith('sample-')) continue
    if (!seedProjects().some((s) => s.meta.id === meta.id)) continue
    try {
      const file = await invoke<unknown>('load_project', { id: meta.id })
      const invalidAssetKeys = await invoke<string[]>('verify_project_assets', {
        id: meta.id,
        assets: (file as { assets?: unknown }).assets ?? {},
      })
      const { content, migrated, repaired } = parseProject(file, { projectId: meta.id, invalidAssetKeys })
      if (migrated || repaired) {
        await tauriSave(meta.id, content)
        repairedAny = true
      }
    } catch (err) {
      console.warn('[projectStore] 示例升级检查失败，保留该示例现状', meta.id, err)
    }
  }
  return repairedAny
}

export async function tauriList(): Promise<ProjectSummary[]> {
  const { invoke } = await import('@tauri-apps/api/core')
  // 回写改写了名称/统计并盖戳 updatedAt：metas 是写前快照，直接返回会让
  // 首页滞留旧名旧序——重列直到无回写（回写后的净本不再触发写，循环有界）
  for (;;) {
    const metas = await invoke<
      { id: string; name: string; updated_at: string; scene_count: number; ending_count: number }[]
    >('list_projects')
    if (metas.length === 0) {
      if (!(await seedFirstRun())) return metas.map(toSummary)
      continue
    }
    if (await upgradeKnownSamples(metas)) continue
    return metas.map(toSummary)
  }
}

export async function tauriCreate(name: string): Promise<ProjectSummary> {
  const { invoke } = await import('@tauri-apps/api/core')
  return toSummary(
    await invoke<{ id: string; name: string; updated_at: string; scene_count: number; ending_count: number }>(
      'create_project',
      { name },
    ),
  )
}

export async function tauriLoad(id: string): Promise<ProjectContent> {
  const { invoke } = await import('@tauri-apps/api/core')
  // 单循环三段：链静止 → 失败登记复验（优先）→ 磁盘读取（链身份守卫）。
  // 任何段的重启都回到循环顶——尤其磁盘段读取期间排队的保存若失败，其
  // 失败登记（比磁盘新）必须在下一轮的登记复验段被优先交付，不得只在
  // 磁盘段内重读旧盘。
  //
  // 登记段：链静止后优先交付链上失败登记的最新文档（冲刷失败待重试，比
  // 磁盘新）：经保存同款归一化（剥离运行态）交付，否则用户看到丢编辑的
  // 旧版本，且随后编辑与重试登记竞态。登记文档同样过加载侧资产实路径
  // 复验——保存失败的常见原因正是资产文件缺失/被换符号链接，不复验就把
  // 带坏资产的文档交付会话、重试登记也原样持有，此后每次重试与后续编辑
  // 都注定失败；隔离后的修复内容同时替换重试登记（后台重试改持净载荷）。
  // 复验的 await 期间登记可能被更新保存清除/替换（重试成功、新失败）：
  // 只有仍是观察到的那份才替换——无条件写回会把已被取代的旧文档复活
  // 进登记与交付，编辑即覆盖新保存；否则按当前保存状态整体重来。
  //
  // 磁盘段：load_project/复验的 await 期间可能又有保存排队（如编辑器卸载
  // 冲刷）——读到的会是写前旧文件；不重验就继续会把旧内容交付会话，且
  // 随后的修复回写若晚于新保存落盘，会把新内容反向覆盖。链身份变化即
  // 重启到循环顶（等待新链落定；失败登记由登记段接管），保证「读到即最新」
  for (;;) {
    await waitForSaveChainIdle(id)
    const pending = pendingRetryDocs.get(id)
    if (pending !== undefined) {
      const invalid = await invoke<string[]>('verify_project_assets', {
        id,
        assets: pending.assets ?? {},
      })
      if (pendingRetryDocs.get(id) !== pending) continue
      const verified = memoryNormalize(pending, id, invalid)
      pendingRetryDocs.set(id, verified)
      return verified
    }
    const chainBefore = saveChains.get(id)
    const file = await invoke<unknown>('load_project', { id })
    // §7.1/§10.5 加载侧资产实路径复验：Rust 以受信资产根 no-follow 验证
    // （前端无法访问文件系统），不可验证键交归一化层隔离、引用位标记悬空
    // ——否则下一次保存会被保存边界拒收而防抖吞错，用户编辑永不落盘
    const invalidAssetKeys = await invoke<string[]>('verify_project_assets', {
      id,
      assets: (file as { assets?: unknown }).assets ?? {},
    })
    if (saveChains.get(id) !== chainBefore) continue
    // §11 归一化管线：迁移 + 孤儿边隔离 + 悬空引用标记；
    // projectId 为路径给定的受信 id，供 §11.1 元数据修复覆盖 project.id
    const { content, migrated, repaired, warnings, reissuedAssetAliases } = parseProject(file, { projectId: id, invalidAssetKeys })
    for (const w of warnings) console.warn(`[projectStore] ${w}`)
    await registerAssetAliases(id, reissuedAssetAliases)
    // 别名登记的异步 IPC 期间可能又有新保存排队（如编辑器卸载冲刷）：
    // 顶部链身份检查已失效，此刻修复回写会把旧内容排在较新保存之后反向
    // 覆盖用户编辑——链身份变化即重启到循环顶（评审修复 P2-6，与读盘
    // 段守卫同款语义；别名登记幂等，重来无副作用）
    if (saveChains.get(id) !== chainBefore) continue
    // 迁移或修复发生则写回磁盘（下次打开不再迁移/重复修复）。v1 的可修复
    // 脏数据（空白/重复 id 等）只修在内存时，用户只开不编辑（防抖保存跳过
    // 首帧）会让脏文件长留磁盘，每次打开都重新生成不同的"稳定" id——修复
    // 必须落定。回写走保存链且完成前不返回（此刻链静止、身份未变，同步段
    // 内入队不会被插队）：与读取后排队的新保存保持全序，迟到的旧内容不得
    // 覆盖新保存；失败只诊断不阻断（显式 catch，不留未处理拒绝），由链的
    // 重试登记接管——内存已交付修复结果，磁盘保持旧内容，下次打开会重新修复
    if (migrated || repaired) {
      await enqueueSave(id, content).catch((err: unknown) => {
        console.error('[projectStore] 迁移/修复回写失败，已登记后台重试（下次打开将重新修复）', err)
      })
    }
    return content
  }
}

/** 登记加载归一化的资产空白键重发别名（issue #31 评审修复 P2-3）：修复
 * 回写按防抖节律才落盘，期间重发 id 的媒体经盘上条目解析；单条登记失败
 * 只诊断不阻断加载（下次打开重新归一化重新登记）。 */
async function registerAssetAliases(id: string, aliases: [string, string][]): Promise<void> {
  if (aliases.length === 0) return
  const { invoke } = await import('@tauri-apps/api/core')
  for (const [blankKey, freshId] of aliases) {
    try {
      await invoke('register_project_asset_alias', { id, blankKey, freshId })
    } catch (err) {
      console.warn('[projectStore] 资产别名登记失败（媒体在修复回写落盘前暂不可见）', freshId, err)
    }
  }
}
