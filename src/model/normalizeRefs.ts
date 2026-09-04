/**
 * 悬空设定/资产引用的标记（§11.4 / §8.2.3）：只记警告不清除 id——场景
 * characterIds/locationId、对白 speaker 与 @ 提及 token、分镜 assetId 的
 * 目标缺失或 MIME 用途不匹配，均按悬空/不可用引用保留展示；
 * shotRefMimeMatches 同时供设置面板的编辑边界共用。
 */
import { SAFE_CHARACTER_ID } from './normalizeSettings'
import type { ProjectDocument, StoryNode } from './document'

/** 场景节点的悬空角色/地点引用警告（§11.4）：只记警告，不清除 id。
 * 桶缺失（Rust 兼容默认 settings:{}）按空集合处理，不抛错。 */
function sceneRefWarnings(
  n: StoryNode,
  doc: ProjectDocument,
  warnings: string[],
): void {
  const s = n.data.spec as { characterIds?: string[]; locationId?: string }
  const characters = doc.settings.characters ?? {}
  const locations = doc.settings.locations ?? {}
  for (const cid of s.characterIds ?? []) {
    if (!characters[cid]) {
      warnings.push(`节点 ${n.id} 引用了不存在的角色 ${cid}`)
    }
  }
  if (s.locationId && !locations[s.locationId]) {
    warnings.push(`节点 ${n.id} 引用了不存在的地点 ${s.locationId}`)
  }
}

/** 设定集实体的悬空头像资产引用警告（§11.4）：avatarAssetId 在
 * Character 实体上（非节点 spec），指向 assets.byId 中不存在的条目即警告。 */
export function characterAvatarWarnings(doc: ProjectDocument, warnings: string[]): void {
  for (const ch of Object.values(doc.settings.characters ?? {})) {
    if (ch.avatarAssetId && !doc.assets?.byId[ch.avatarAssetId]) {
      warnings.push(`角色 ${ch.name}（${ch.id}）的头像引用了不存在的资产 ${ch.avatarAssetId}`)
    }
  }
}

/** 对白节点的悬空 speaker 引用警告（§11.4）：只记警告，不清除 id。 */
function dialogueRefWarnings(
  n: StoryNode,
  doc: ProjectDocument,
  warnings: string[],
): void {
  const characters = doc.settings.characters ?? {}
  for (const line of (n.data.spec as { lines?: { speaker?: string }[] }).lines ?? []) {
    if (line.speaker && !characters[line.speaker]) {
      warnings.push(`节点 ${n.id} 的对白引用了不存在的角色 ${line.speaker}`)
    }
  }
}

/** 分镜引用位的 MIME 家族与 kind 用途匹配（§4.2 六十四轮）：character/
 * location 是垫图/底图用途限 image/*，audio 用途限 audio/*。
 * 归一化（不可用引用警告）与设置面板的编辑边界（禁用错配 kind）共用。 */
export function shotRefMimeMatches(kind: string, mime: string): boolean {
  if (kind === 'audio') return mime.startsWith('audio/')
  return mime.startsWith('image/')
}

/** 分镜节点的引用位警告（§11.4 + §4.2 六十四轮）：assetId 只按本项目
 * assets.byId 解析——目标缺失保留为悬空引用并警告（不删除用户选择）；
 * 目标存在但 MIME 家族与 kind 用途不匹配时保留为不可用引用并警告，
 * 不改按其他命名空间解释。 */
function shotRefWarnings(n: StoryNode, doc: ProjectDocument, warnings: string[]): void {
  const refs = (n.data.spec as { refs?: Array<{ id: string; kind: string; assetId?: string }> }).refs ?? []
  for (const ref of refs) {
    if (!ref.assetId) continue
    const asset = doc.assets?.byId[ref.assetId]
    if (!asset) {
      warnings.push(`节点 ${n.id} 的分镜引用指向不存在的资产 ${ref.assetId}`)
      continue
    }
    if (!shotRefMimeMatches(ref.kind, asset.mime)) {
      warnings.push(`节点 ${n.id} 的分镜引用 ${ref.id} 的 MIME 家族与 kind 用途不匹配（资产 ${ref.assetId} 为 ${asset.mime}），保留为不可用引用`)
    }
  }
}

/** 对白文本的 @ 提及 token 扫描（§11.1 第 5 步）：按 §8.1.2 固定语法
 * 判定 token 形片段——`@[character:<安全 id>]` 为合法 token，目标不存在时
 * 警告失效（token 本身保留，悬空展示与恢复由 UI 消费）；近似但非法的
 * 片段（id 不满足安全字符集、未闭合）保留原文并警告。文本一律不改写。 */
function dialogueMentionWarnings(n: StoryNode, doc: ProjectDocument, warnings: string[]): void {
  const lines = (n.data.spec as { lines?: Array<{ text?: unknown }> }).lines ?? []
  for (const [i, line] of lines.entries()) {
    if (typeof line.text !== 'string') continue
    for (const issue of mentionIssuesOfLine(line.text, doc.settings.characters ?? {})) {
      warnings.push(`节点 ${n.id} 的对白行 ${i} ${issue}`)
    }
  }
}

/** 单行文本的 @ 提及 token 判定（dialogueMentionWarnings 内核，S3776 拆解）：
 * 逐片段返回问题文案（空数组 = 无问题），不改写文本。 */
function mentionIssuesOfLine(
  text: string,
  characters: Record<string, unknown>,
): string[] {
  const issues: string[] = []
  const prefix = '@[character:'
  let from = 0
  for (;;) {
    const start = text.indexOf(prefix, from)
    if (start === -1) return issues
    const close = text.indexOf(']', start + prefix.length)
    if (close === -1) {
      issues.push('含未闭合的提及 token 片段，已保留原文')
      return issues
    }
    const id = text.slice(start + prefix.length, close)
    if (!SAFE_CHARACTER_ID.test(id)) {
      issues.push('含非法的提及 token 形片段，已保留原文')
    } else if (characters[id] === undefined) {
      issues.push(`的提及 token @[character:${id}] 目标不存在，已标记失效（token 保留）`)
    }
    from = close + 1
  }
}

/** 按节点类型分发悬空设定/资产引用检查（§11.4）。 */
export function collectDanglingRefWarnings(
  n: StoryNode,
  doc: ProjectDocument,
  warnings: string[],
): void {
  if (n.type === 'scene') sceneRefWarnings(n, doc, warnings)
  if (n.type === 'dialogue') {
    dialogueRefWarnings(n, doc, warnings)
    dialogueMentionWarnings(n, doc, warnings)
  }
  if (n.type === 'shot') shotRefWarnings(n, doc, warnings)
}
