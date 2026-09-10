/**
 * 项目持久化前端门面（docs/ui-design.md §3.2、数据模型 v1 §10–§11）。
 * Tauri 环境走 Rust 命令（JSON 文件落盘于应用数据目录）；
 * 纯浏览器预览无 IPC，回退为同接口的内存实现（刷新即失，仅保交互可验）。
 * 落盘格式为 ProjectDocument（src/model/document.ts）；序列化/归一化/迁移
 * 在 src/model/convert.ts。统一约定：updatedAt 对外为 ISO 字符串。
 *
 * 域拆分（issue #39）：seeds（演示种子）、memory（内存回退）、saveChain
 * （§3.1 保存链与删除墓碑）、tauri（Rust 命令域）；本文件保留环境分派、
 * 复制命名规则与统一门面。
 */
import type { ProjectContent } from './model/content'
import {
  memoryCreate,
  memoryDelete,
  memoryList,
  memoryLoad,
  memorySave,
} from './projectStore/memory'
import { enqueueDelete, enqueueSave } from './projectStore/saveChain'
import { tauriCreate, tauriList, tauriLoad } from './projectStore/tauri'
import type { ProjectSummary } from './home/projects'
import { deleteAiSession, loadAiSession, onAiSessionSaved, saveAiSession } from './aiSessionStore'
import type { AiSession } from './editor/ai/session'

export type { ProjectContent }

const isTauri =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

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

  /** 项目 AI 会话独立于画布文档保存，旧项目无文件时返回空历史。 */
  loadAiSession,

  /** AI 会话保存失败上浮给面板展示；内存历史不随失败清空。 */
  saveAiSession: (id: string, session: AiSession): Promise<void> => saveAiSession(id, session),

  /** 订阅会话落盘成功（含不经面板通道的退出重试）：App 据此清除
   * 项目级保存错误与保留快照。 */
  onAiSessionSaved,

  /** 删除项目（首页卡片菜单，§3.2；确认框由界面层负责）。排进保存链，
   * 迟到的保存/重试不得复活已删项目。 */
  delete: async (id: string): Promise<void> => {
    if (isTauri) await enqueueDelete(id)
    else await memoryDelete(id)
    deleteAiSession(id)
  },

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
