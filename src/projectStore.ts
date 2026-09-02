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

/** 会话文档 → 归一化后的会话文档（serialize 剥离运行态 + parse 重置选中态）。 */
function memoryNormalize(doc: ProjectContent, id: string): ProjectContent {
  return parseProject(serializeProject(doc, id), { projectId: id }).content
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
  // 种子文件升级：示例项目仍是旧格式（schemaVersion 0）时直接覆盖新种子
  for (const meta of metas) {
    if (!meta.id.startsWith('sample-')) continue
    const seed = seedProjects().find((s) => s.meta.id === meta.id)
    if (!seed) continue
    const file = await invoke<unknown>('load_project', { id: meta.id })
    if (parseProject(file, { projectId: meta.id }).migrated) {
      await tauriSave(meta.id, seed.doc)
    }
  }
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

async function tauriLoad(id: string): Promise<ProjectContent> {
  const { invoke } = await import('@tauri-apps/api/core')
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
  const { content, migrated, warnings } = parseProject(file, { projectId: id, invalidAssetKeys })
  for (const w of warnings) console.warn(`[projectStore] ${w}`)
  // 迁移发生则写回磁盘（下次打开不再迁移）。回写完成前不返回：load 后
  // 紧随的保存（如首页改名）不得与慢回写竞态——先返回再让旧内容后完成
  // 落盘会反向覆盖新保存。失败只诊断不阻断（显式 catch，不留未处理拒绝）：
  // 内存已交付迁移结果，磁盘保持旧格式，下次打开会重新迁移
  if (migrated) {
    try {
      await tauriSave(id, content)
    } catch (err) {
      console.error('[projectStore] 迁移回写失败，磁盘仍为旧格式（下次打开将重新迁移）', err)
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

function clearSaveRetry(id: string): void {
  const timer = retryTimers.get(id)
  if (timer !== undefined) {
    clearTimeout(timer)
    retryTimers.delete(id)
  }
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
  const generation = (saveGenerations.get(id) ?? 0) + 1
  saveGenerations.set(id, generation)
  const run = (saveChains.get(id) ?? Promise.resolve()).catch(() => undefined)
  const next = run.then(async () => {
    try {
      await tauriSave(id, doc)
      pendingRetryDocs.delete(id)
    } catch (err) {
      pendingRetryDocs.set(id, doc)
      if (!retryTimers.has(id)) scheduleSaveRetry(id, generation)
      console.error('[projectStore] 保存失败，已登记后台重试', err)
      throw err
    }
  })
  saveChains.set(id, next)
  return next
}

/** 删除排进同项目保存链：在途保存落定后才发出删除（迟到的保存完成不得
 * 重建 JSON 复活项目）；并取消全部重试登记（登记中的重试同样会复活）。 */
function enqueueDelete(id: string): Promise<void> {
  clearSaveRetry(id)
  const run = (saveChains.get(id) ?? Promise.resolve()).catch(() => undefined)
  const next = run.then(async () => {
    clearSaveRetry(id)
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('delete_project', { id })
  })
  saveChains.set(id, next)
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
