/**
 * 项目持久化前端门面（docs/ui-design.md §3.2、数据模型 v1 §10–§11）。
 * Tauri 环境走 Rust 命令（JSON 文件落盘于应用数据目录）；
 * 纯浏览器预览无 IPC，回退为同接口的内存实现（刷新即失，仅保交互可验）。
 * 落盘格式为 ProjectDocument（src/model/document.ts）；序列化/归一化/迁移
 * 在 src/model/convert.ts。统一约定：updatedAt 对外为 ISO 字符串。
 */
import { parseProject, serializeProject } from './model/convert'
import type { ProjectContent } from './model/content'
import { SAMPLE_NODES, SAMPLE_EDGES } from './editor/sampleGraph'
import { SAMPLE_SETTINGS } from './editor/sampleData'
import type { ProjectSummary } from './home/projects'

export type { ProjectContent }

/** 首次启动的种子项目：沿用演示画布，让首页与编辑器开箱即有内容。 */
function seedProjects(): { meta: ProjectSummary; doc: ProjectContent }[] {
  const hoursAgo = (h: number) =>
    new Date(Date.now() - h * 3_600_000).toISOString()
  const sceneCount = SAMPLE_NODES.filter((n) => n.type === 'scene').length
  return [
    {
      meta: {
        id: 'sample-wu-ye-chu-zu-che',
        name: '午夜出租车',
        sceneCount,
        endingCount: 2,
        updatedAt: hoursAgo(26),
      },
      doc: { name: '午夜出租车', nodes: SAMPLE_NODES, edges: SAMPLE_EDGES, settings: SAMPLE_SETTINGS },
    },
    {
      meta: {
        id: 'sample-du-shi-qi-yuan',
        name: '都市奇缘',
        sceneCount: 24,
        endingCount: 2,
        cover: 'linear-gradient(160deg, #2b2f4c, #e0176e)',
        updatedAt: hoursAgo(2),
      },
      doc: { name: '都市奇缘', nodes: SAMPLE_NODES, edges: SAMPLE_EDGES, settings: SAMPLE_SETTINGS },
    },
  ]
}

/** 复制命名（§7.3）：新名 = `{源名} 副本`，与现存项目名冲突则递增序号
 * （` 副本 2`、` 副本 3`…）；拼接结果按字符数超 64（§9.3 校验口径）时先
 * 截断源名至可容纳后缀再拼接——复制必须总能成功，不得因上限被持久化层拒绝。 */
function duplicateName(source: string, taken: ReadonlySet<string>): string {
  const build = (suffix: string): string => {
    const room = Math.max(1, 64 - [...suffix].length)
    const head = [...source.trim()].slice(0, room).join('').trimEnd() || '未命名'
    return head + suffix
  }
  const first = build(' 副本')
  if (!taken.has(first)) return first
  for (let n = 2; ; n++) {
    const candidate = build(` 副本 ${n}`)
    if (!taken.has(candidate)) return candidate
  }
}

const isTauri =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

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

/** 内存回退实现：模块级 Map，会话内持久。存归一化后的会话文档——
 * 与桌面路径同规则（保存即序列化剥离会话态 + 归一化），行为不因环境分叉。 */
const memoryStore = new Map<string, { doc: ProjectContent; updatedAt: number }>()
let memorySeeded = false

/** 会话文档 → 归一化后的会话文档（serialize 剥离运行态 + parse 重置选中态）；
 * invalidAssetKeys 为 Rust 实路径复验未通过的资产键，归一化据此隔离索引。 */
function memoryNormalize(
  doc: ProjectContent,
  id: string,
  invalidAssetKeys?: readonly string[],
): ProjectContent {
  return parseProject(serializeProject(doc, id), {
    projectId: id,
    ...(invalidAssetKeys !== undefined ? { invalidAssetKeys } : {}),
  }).content
}

function memoryList(): ProjectSummary[] {
  if (!memorySeeded) {
    for (const seed of seedProjects()) {
      memoryStore.set(seed.meta.id, {
        doc: memoryNormalize(seed.doc, seed.meta.id),
        updatedAt: Date.parse(seed.meta.updatedAt),
      })
    }
    memorySeeded = true
  }
  const countScenes = (nodes: ProjectContent['nodes']) =>
    nodes.filter((n) => n.type === 'scene').length
  return [...memoryStore.entries()]
    .map(([id, { doc, updatedAt }]) => {
      const hasOutgoing = new Set(
        doc.edges.map((e) => e.source),
      )
      const endings = doc.nodes.filter(
        (n) => n.type === 'scene' && !hasOutgoing.has(n.id),
      ).length
      return {
        id,
        name: doc.name,
        sceneCount: countScenes(doc.nodes),
        ...(endings > 1 ? { endingCount: endings } : {}),
        updatedAt: new Date(updatedAt).toISOString(),
      }
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

async function tauriList(): Promise<ProjectSummary[]> {
  const { invoke } = await import('@tauri-apps/api/core')
  const metas = await invoke<
    { id: string; name: string; updated_at: string; scene_count: number; ending_count: number }[]
  >('list_projects')
  // 首次启动（无任何项目文件）时写入种子示例，保证开箱即有内容
  if (metas.length === 0) {
    for (const seed of seedProjects()) {
      await tauriSave(seed.meta.id, seed.doc)
    }
    return tauriList()
  }
  // 示例项目的旧格式（schemaVersion 0）迁移与 v1 修复型归一化同样回写：
  // 写回**迁移/修复后的用户内容**——示例可能已被编辑（改名/加场景/资产），
  // 用硬编码种子覆盖会在升级后首次打开首页时静默摧毁这些编辑；
  // 演示内容刷新只经由空库播种路径发生
  let repairedAny = false
  for (const meta of metas) {
    if (!meta.id.startsWith('sample-')) continue
    if (!seedProjects().some((s) => s.meta.id === meta.id)) continue
    const file = await invoke<unknown>('load_project', { id: meta.id })
    const { content, migrated, repaired } = parseProject(file, { projectId: meta.id })
    if (migrated || repaired) {
      await tauriSave(meta.id, content)
      repairedAny = true
    }
  }
  // 回写改写了名称/统计与盖戳 updatedAt：metas 是写前快照，直接返回会让
  // 首页滞留旧名旧序——重列一次（回写后的净本不再触发写，递归有界）
  if (repairedAny) return tauriList()
  return metas.map(toSummary)
}

async function tauriCreate(name: string): Promise<ProjectSummary> {
  const { invoke } = await import('@tauri-apps/api/core')
  return toSummary(
    await invoke<{ id: string; name: string; updated_at: string; scene_count: number; ending_count: number }>(
      'create_project',
      { name },
    ),
  )
}

/** 等待该项目的保存链静止（§3.1，tauriLoad 内核）：await 后仍是同一
 * Promise 即静止。编辑器卸载后的冲刷可能在途/排队，旧编辑器的防抖还
 * 可能在 A 在途时又补交 B——单次等待只等 A，读盘落在 B 之前会让重开
 * 后的编辑把旧内容重新落盘、反向覆盖 B。 */
async function waitForSaveChainIdle(id: string): Promise<void> {
  for (;;) {
    const chain = saveChains.get(id)
    if (chain === undefined) return
    await chain.catch(() => undefined)
    if (saveChains.get(id) === chain) return
  }
}

async function tauriLoad(id: string): Promise<ProjectContent> {
  const { invoke } = await import('@tauri-apps/api/core')
  // 链静止后优先交付链上失败登记的最新文档（冲刷失败待重试，比磁盘新）：
  // 经保存同款归一化（剥离运行态）交付，否则用户看到丢编辑的旧版本，
  // 且随后编辑与重试登记竞态。登记文档同样过加载侧资产实路径复验——
  // 保存失败的常见原因正是资产文件缺失/被换符号链接，不复验就把带
  // 坏资产的文档交付会话、重试登记也原样持有，此后每次重试与后续编辑
  // 都注定失败；隔离后的修复内容同时替换重试登记（后台重试改持净载荷）。
  // 复验的 await 期间登记可能被更新保存清除/替换（重试成功、新失败）：
  // 只有仍是观察到的那份才替换——无条件写回会把已被取代的旧文档复活
  // 进登记与交付，编辑即覆盖新保存；否则按当前保存状态整体重来
  for (;;) {
    await waitForSaveChainIdle(id)
    const pending = pendingRetryDocs.get(id)
    if (pending === undefined) break
    const invalid = await invoke<string[]>('verify_project_assets', {
      id,
      assets: pending.assets ?? {},
    })
    if (pendingRetryDocs.get(id) !== pending) continue
    const verified = memoryNormalize(pending, id, invalid)
    pendingRetryDocs.set(id, verified)
    return verified
  }
  const file = await invoke<unknown>('load_project', { id })
  // §7.1/§10.5 加载侧资产实路径复验：Rust 以受信资产根 no-follow 验证
  // （前端无法访问文件系统），不可验证键交归一化层隔离、引用位标记悬空
  // ——否则下一次保存会被保存边界拒收而防抖吞错，用户编辑永不落盘
  const invalidAssetKeys = await invoke<string[]>('verify_project_assets', {
    id,
    assets: (file as { assets?: unknown }).assets ?? {},
  })
  // §11 归一化管线：迁移 + 孤儿边隔离 + 悬空引用标记；
  // projectId 为路径给定的受信 id，供 §11.1 元数据修复覆盖 project.id
  const { content, migrated, repaired, warnings } = parseProject(file, { projectId: id, invalidAssetKeys })
  for (const w of warnings) console.warn(`[projectStore] ${w}`)
  // 迁移或修复发生则写回磁盘（下次打开不再迁移/重复修复）。v1 的可修复
  // 脏数据（空白/重复 id 等）只修在内存时，用户只开不编辑（防抖保存跳过
  // 首帧）会让脏文件长留磁盘，每次打开都重新生成不同的"稳定" id——修复
  // 必须落定。回写完成前不返回：load 后紧随的保存（如首页改名）不得与慢
  // 回写竞态——先返回再让旧内容后完成落盘会反向覆盖新保存。失败只诊断
  // 不阻断（显式 catch，不留未处理拒绝）：内存已交付修复结果，磁盘保持
  // 旧内容，下次打开会重新修复
  if (migrated || repaired) {
    try {
      await tauriSave(id, content)
    } catch (err) {
      console.error('[projectStore] 迁移/修复回写失败，磁盘仍为旧内容（下次打开将重新修复）', err)
    }
  }
  return content
}

async function tauriSave(id: string, doc: ProjectContent): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('save_project', { id, doc: serializeProject(doc, id) })
}

/** §3.1 项目级持久化所有者：保存按项目串行（后保存者的内容永不早于先
 * 保存者落盘）；失败把最新文档登记为待重试并按固定节律后台重试——编辑
 * 器卸载/导航后组件不复存在，最新文档只存在于这里，瞬时故障（磁盘满/
 * 权限）不得永久丢编辑。重试绑定**保存代次**：每次入队自增，新保存一
 * 排队旧代次重试即作废——陈旧文档的重试不得后完成覆盖新内容。删除同样
 * 排进链：在途保存落定后才删，且先取消全部重试登记，已删项目不得被
 * 迟到的完成/重试复活。 */
const SAVE_RETRY_DELAY_MS = 5000
const saveChains = new Map<string, Promise<unknown>>()
const pendingRetryDocs = new Map<string, ProjectContent>()
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const saveGenerations = new Map<string, number>()
/** 删除墓碑：删除开始即立——之后为该项目排队的任何保存被吸收，迟到的
 * 合并冲刷/重试不得重建 JSON 复活用户刚删的项目；删除落定（成功或失败）
 * 后清除，失败时项目仍在、可继续保存。 */
const deletingIds = new Set<string>()
/** 删除期间被吸收的迟到保存：留存最新文档——删除失败（项目仍在磁盘）时
 * 回吐重存，否则该次冲刷已被上游视为成功，最新编辑既没落盘也无重试
 * 登记；删除成功即随项目一并丢弃，绝不复活已删项目。 */
const absorbedSaveDocs = new Map<string, ProjectContent>()

/** 取消后台重试定时器（不触碰登记文档）：删除开场只需停摆定时器——墓碑
 * 期定时器即使触发也只会被 enqueueSave 吸收（不会复活已删项目），但停摆
 * 更干净；登记文档留待链落定处的全量清除与回吐判定。 */
function clearSaveRetryTimer(id: string): void {
  const timer = retryTimers.get(id)
  if (timer !== undefined) {
    clearTimeout(timer)
    retryTimers.delete(id)
  }
}

function clearSaveRetry(id: string): void {
  clearSaveRetryTimer(id)
  pendingRetryDocs.delete(id)
}

function scheduleSaveRetry(id: string, generation: number): void {
  retryTimers.set(
    id,
    setTimeout(() => {
      retryTimers.delete(id)
      // 代次已前进（有更新的保存排队/完成）：本次登记作废，由新代次自洽
      if (saveGenerations.get(id) !== generation) return
      const doc = pendingRetryDocs.get(id)
      if (doc !== undefined) void enqueueSave(id, doc).catch(() => undefined)
    }, SAVE_RETRY_DELAY_MS),
  )
}

function enqueueSave(id: string, doc: ProjectContent): Promise<void> {
  if (deletingIds.has(id)) {
    // 吸收但不丢弃：留存最新文档，删除失败时回吐（见 enqueueDelete）
    absorbedSaveDocs.set(id, doc)
    console.warn('[projectStore] 项目删除中，吸收本次保存排队', id)
    return Promise.resolve()
  }
  const generation = (saveGenerations.get(id) ?? 0) + 1
  saveGenerations.set(id, generation)
  const run = (saveChains.get(id) ?? Promise.resolve()).catch(() => undefined)
  const next = run.then(async () => {
    try {
      await tauriSave(id, doc)
      pendingRetryDocs.delete(id)
    } catch (err) {
      pendingRetryDocs.set(id, doc)
      // 新代次失败接管定时器：旧代次定时器留着会在触发时因代次不符自灭，
      // 最新登记将无人重试（编辑器已卸载时即永久丢编辑）
      const stale = retryTimers.get(id)
      if (stale !== undefined) {
        clearTimeout(stale)
        retryTimers.delete(id)
      }
      scheduleSaveRetry(id, generation)
      console.error('[projectStore] 保存失败，已登记后台重试', err)
      throw err
    }
  })
  saveChains.set(id, next)
  return next
}

/** 删除排进同项目保存链：在途保存落定后才发出删除（迟到的保存完成不得
 * 重建 JSON 复活项目）；开场只停摆重试定时器、保留登记文档——登记反映
 * 「最新未落盘的失败保存」，后续保存成功会自行清除它；墓碑先行，删除排队
 * 期间及之后的保存一律吸收。链落定时读取登记（在途保存失败后新登记的、
 * 或开场留存仍未被取代的）并全量清除，随后删除。删除失败（项目仍在磁盘）
 * 时按入队序回吐：先链落定时留存的登记文档、再墓碑期间吸收的最新文档
 * 重新排队保存——不回吐则最新编辑既没落盘也无重试登记；登记为空即最新
 * 保存已成功（或从未失败），不得回放更早的旧登记（陈旧文档的重试不得
 * 覆盖新内容）；删除成功则登记与吸收的文档随项目一并丢弃。 */
function enqueueDelete(id: string): Promise<void> {
  deletingIds.add(id)
  clearSaveRetryTimer(id)
  const run = (saveChains.get(id) ?? Promise.resolve()).catch(() => undefined)
  let retainedRetryDoc: ProjectContent | undefined
  const next = run.then(async () => {
    // 只认此刻的登记：后续保存成功已把它清除（旧代次作废），回退到开场
    // 捕获值会把被取代的旧文档重放覆盖已落盘的新内容
    retainedRetryDoc = pendingRetryDocs.get(id)
    clearSaveRetry(id)
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('delete_project', { id })
  })
  next
    .finally(() => {
      deletingIds.delete(id)
    })
    .then(
      () => {
        absorbedSaveDocs.delete(id)
      },
      () => {
        // 墓碑已解除（finally 先行）：回吐的保存走正常排队，不再被吸收
        const retained = retainedRetryDoc
        const absorbed = absorbedSaveDocs.get(id)
        absorbedSaveDocs.delete(id)
        if (retained !== undefined) void enqueueSave(id, retained).catch(() => undefined)
        if (absorbed !== undefined) void enqueueSave(id, absorbed).catch(() => undefined)
      },
    )
    .catch(() => undefined)
  saveChains.set(id, next.catch(() => undefined))
  return next
}

/** 统一门面：两种环境同签名。 */
export const projectStore = {
  list: (): Promise<ProjectSummary[]> =>
    isTauri ? tauriList() : Promise.resolve(memoryList()),

  create: (name: string): Promise<ProjectSummary> =>
    isTauri
      ? tauriCreate(name)
      : Promise.resolve(memoryCreate(name)),

  load: (id: string): Promise<ProjectContent> =>
    isTauri ? tauriLoad(id) : memoryLoad(id),

  save: (id: string, doc: ProjectContent): Promise<void> =>
    isTauri ? enqueueSave(id, doc) : memorySave(id, doc),

  /** 删除项目（首页卡片菜单，§3.2；确认框由界面层负责）。排进保存链，
   * 迟到的保存/重试不得复活已删项目。 */
  delete: (id: string): Promise<void> =>
    isTauri ? enqueueDelete(id) : memoryDelete(id),

  /** 复制项目：读原文档 → 新建「副本」项目 → 整目录拷贝项目资产 → 写入
   * 画布（§3.2）。副本创建时间取复制时刻。资产索引随文档原样带走——与
   * avatarAssetId 等引用字段保持一致解析（§8.1）；媒体文件由 Rust 侧
   * no-follow 拷贝 `projects/{fromId}/assets` → `projects/{toId}/assets`
   * （§7.1/§7.3），先拷贝后保存，保存边界 §10.5 的实路径复验才能通过。
   * 任一步失败：清理刚建的空副本项目后向前抛出，绝不静默吞错返回空项目。 */
  duplicate: async (id: string): Promise<ProjectSummary> => {
    const doc = await projectStore.load(id)
    // 命名先于创建（§7.3）：截断保上限 + 冲突递增序号，create 永不因名校验拒绝
    const taken = new Set((await projectStore.list()).map((p) => p.name))
    const name = duplicateName(doc.name, taken)
    const meta = await projectStore.create(name)
    try {
      if (isTauri) {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('copy_project_assets', { fromId: id, toId: meta.id })
      }
      await projectStore.save(meta.id, { ...doc, name, createdAt: undefined })
    } catch (err) {
      console.warn('[projectStore] 复制项目失败，清理已建副本', err)
      // 清理完成后再抛：调用方看到失败时首页不会遗留空「副本」卡片；
      // 清理自身也失败时合并双错向前抛出并报告可能遗留的副本 id，
      // 绝不静默吞掉（否则空/半拷贝副本永留首页且无人知晓）
      await projectStore.delete(meta.id).catch((cleanupErr: unknown) => {
        console.error('[projectStore] 副本清理失败，首页可能遗留空副本，可手动删除', meta.id, cleanupErr)
        throw new Error(
          `复制项目失败（${String(err)}），且副本 ${meta.id} 清理失败（${String(cleanupErr)}）——首页可能遗留空副本，可手动删除`,
        )
      })
      throw err
    }
    return { ...meta, sceneCount: meta.sceneCount }
  },

  /** 静默吞掉持久化错误：画布交互不因落盘失败中断，仅控制台留痕。 */
  saveQuiet: async (id: string, doc: ProjectContent): Promise<void> => {
    try {
      await projectStore.save(id, doc)
    } catch (err) {
      console.warn('[projectStore] 保存失败', err)
    }
  },
}

function memoryCreate(name: string): ProjectSummary {
  // 随机尾防同毫秒碰撞（如「复制」紧跟「新建」）：时间戳 id 撞 key 会静默覆盖项目
  const id = `local-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`
  const now = Date.now()
  memoryStore.set(id, {
    doc: {
      name,
      createdAt: new Date(now).toISOString(),
      nodes: [],
      edges: [],
      settings: { characters: [], locations: [] },
    },
    updatedAt: now,
  })
  return { id, name, sceneCount: 0, updatedAt: new Date(now).toISOString() }
}

async function memoryLoad(id: string): Promise<ProjectContent> {
  const entry = memoryStore.get(id)
  if (!entry) throw new Error(`项目不存在：${id}`)
  // 内存实现只存当前格式，深拷贝即完整文档
  return JSON.parse(JSON.stringify(entry.doc)) as ProjectContent
}

async function memorySave(id: string, doc: ProjectContent): Promise<void> {
  memoryStore.set(id, { doc: memoryNormalize(doc, id), updatedAt: Date.now() })
}

async function memoryDelete(id: string): Promise<void> {
  memoryStore.delete(id)
}
