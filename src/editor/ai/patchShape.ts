import { uid } from '../../uid'
import {
  ENTITY_KIND_LABELS,
  type EntityKind,
  type EntityTokenScope,
} from './entityFields'

/**
 * AI 入站 data/patch 的值形状校验与列表项归一化（信任边界，§9.3/§11.3
 * 的批命令对等，commands.ts 拆分）。字段键白名单门（checkFieldKeys）留在
 * commands.ts 的折叠校验；本模块消费已过白名单的字段对象，负责两件事：
 * 异型**值**的形状校验（放行会经判别补丁摊进活动节点，渲染层解引用即崩，
 * 加载归一化来不及兜底）与列表项的入站归一化（旧契约形态升级 + 稳定 id）。
 */

export function plainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 结构化引用的实体解析（issue 44）：快照未携带设定集时不校验（旧夹具兼容）；
 * contingent = 引用指向本批失败的 upsert，随前序修复自愈，本轮跳过；
 * 跨种类（如地点 id 写进 characterIds）与未知实体都整批拒绝——放行即产生
 * 跨类型误绑或悬空引用，保存后加载侧只会静默剥离。 */
function entityRefIssue(
  token: string,
  expect: EntityKind,
  field: string,
  entities?: EntityTokenScope,
): string | null {
  if (entities === undefined) return null
  const kind = entities.kindOf(token, expect)
  if (kind === 'contingent' || kind === expect) return null
  if (kind === null) {
    return `${field} 的${ENTITY_KIND_LABELS[expect]}实体不存在：${token}（新实体须先在本批 upsert_${expect} 声明 ref）`
  }
  return `${field} 指向的是${ENTITY_KIND_LABELS[kind]}实体（须为${ENTITY_KIND_LABELS[expect]}实体 id 或 ref）：${token}`
}

/** 入站归一化（信任边界）：列表项稳定 id 补齐（S6479）。
 * AI 可按旧契约发送无 id 的台词行/引用位、或纯字符串选项；
 * 进画布前统一升级为带 id 结构。已有 id 仅在「非空白（§8.1 共同值域
 * trim 口径，与加载边界同款）且列表内唯一」时保留（幂等）；空白/空串/
 * 重复 id 就地重生成——空白 id 直接作 React key 不可靠，且加载侧会按
 * 空白 id 重发改写身份，被接受的命令不得自带重开即变的“稳定”身份；
 * 冲突会导致行复用/误编辑。非对象条目原样放行（形状校验不在本层）。 */
export function normalizeNodeFields(
  nodeType: string,
  fields: Record<string, unknown>,
  existingOptions?: Array<{ id: string; label: string }>,
): Record<string, unknown> {
  /** 列表项 id 归一化：非空白唯一保留，否则重生成。 */
  const normalizeIds = (items: unknown[], prefix: string): unknown[] => {
    const seen = new Set<string>()
    return items.map((item) => {
      if (!plainObject(item)) return item
      const id = item.id
      if (typeof id === 'string' && id.trim() !== '' && !seen.has(id)) {
        seen.add(id)
        return item
      }
      const fresh = uid(prefix)
      seen.add(fresh)
      return { ...item, id: fresh }
    })
  }
  const out = { ...fields }
  if (nodeType === 'dialogue' && Array.isArray(out.lines)) {
    // 缺省 kind 归一为 'line'（保存内容不被下次加载的判别联合静默删除），
    // 再补稳定 id
    out.lines = normalizeIds(
      (out.lines as unknown[]).map((l) =>
        plainObject(l) && l.kind === undefined ? { ...l, kind: 'line' as const } : l,
      ),
      'line',
    )
  }
  if (nodeType === 'branch' && Array.isArray(out.options)) {
    // 字符串选项（旧契约紧凑形态）在更新路径按位置对位复用既有选项的
    // 稳定 id——整体重发新 id 会让全部既有 option- 句柄被折叠/模拟当作
    // 已删选项，引出连线被静默清除而预览只显示一次普通选项更新；
    // create 无既有选项，超出现有数的字符串仍是新增（normalizeIds 补 id）
    const existing = existingOptions ?? []
    out.options = normalizeIds(
      (out.options as unknown[]).map((o, i) => {
        // 字符串与无 id 的对象简写都按位置对位复用（重命名语义）；显式
        // 合法 id 的对象保留自报 id（用户显式定向到具体选项）
        if (typeof o === 'string') {
          const prev = existing[i]
          return prev !== undefined ? { id: prev.id, label: o } : { label: o }
        }
        if (plainObject(o) && (typeof o.id !== 'string' || o.id.trim() === '')) {
          const prev = existing[i]
          if (prev !== undefined) return { ...o, id: prev.id }
        }
        return o
      }),
      'opt',
    )
  }
  if (nodeType === 'shot' && Array.isArray(out.refs)) {
    out.refs = normalizeIds(out.refs as unknown[], 'ref')
  }
  return out
}

/** 分支 options 入站成员校验（信任边界）：字符串选项（随后由归一化升级为
 * {label} 对象）或带字符串 label 的普通对象才合法。异型成员（null/数字/
 * 缺 label/对象形态 label）若放行，级联簿记的 removedOptionHandles 会对
 * o.id 解引用直接抛异常，对象形态 label 进画布后还会被 BranchNode 当
 * React 子节点渲染而崩溃——返回拒绝原因，null 表示通过。 */
export function branchOptionsError(options: unknown[]): string | null {
  const bad = options.some((o) => typeof o !== 'string' && (!plainObject(o) || typeof o.label !== 'string'))
  return bad ? '分支 options 含异型成员（须为字符串或带字符串 label 的对象）' : null
}

/** shot.refs 成员的引用位联合 + 资产目标校验（§4.2 ShotRef 的信任边界对等，
 * §7.1/§11.3）：与加载侧 isShotRefShape 同口径——双字段**键在场**即非法
 * （值类型 XOR 不足以判定 `{assetId, label: 5}` 这类成员），assetId 须非空白
 * ——空串是 string 但不可解析，装上即永久悬空引用。引用位还须命中快照资产
 * 且 MIME 家族匹配用途（character/location → image/*，audio → audio/*，
 * 与加载侧归一化同域）——不存在的资产或用途错配的引用进画布即悬空/不可用，
 * 保存虽成功、加载侧只会标记问题，AI 边界须前置拒绝。返回拒绝原因；
 * null 表示通过。 */
function shotRefMemberIssue(r: unknown, assets: ReadonlyMap<string, string>): string | null {
  if (!plainObject(r)) return '不是普通对象'
  if (r.kind !== 'character' && r.kind !== 'location' && r.kind !== 'audio') {
    return `kind 未知（${String(r.kind)}）`
  }
  if ('assetId' in r && 'label' in r) return 'assetId 与 label 并存（引用位与自由位互斥）'
  const hasAsset = typeof r.assetId === 'string' && r.assetId.trim() !== ''
  const hasLabel = typeof r.label === 'string'
  if (hasAsset === hasLabel) return 'assetId 非空白字符串 / label 字符串须恰居其一'
  if (!hasAsset) return null
  const mime = assets.get(r.assetId as string)
  if (mime === undefined) {
    return `资产 ${r.assetId as string} 不存在（引用位只按本项目资产索引解析）`
  }
  const family = r.kind === 'audio' ? 'audio/' : 'image/'
  if (!mime.startsWith(family)) {
    return `资产 ${r.assetId as string}（${mime}）与 ${r.kind} 引用用途不匹配（须 ${family}*）`
  }
  return null
}

/** 各类型的标量字段值形状（nodeValueShapeError 的分类型明细）。 */
function scalarShapeIssues(
  nodeType: string,
  fields: Record<string, unknown>,
  entities?: EntityTokenScope,
): string[] {
  const issues: string[] = []
  const str = (f: string) => {
    if (fields[f] !== undefined && typeof fields[f] !== 'string') issues.push(`${f} 须为字符串`)
  }
  // 数值编号域（§9.3 命令边界）：正安全整数——放行 1.5/0/-2 这类值会被
  // 下次加载的归一化静默重编号/删除分集，接受的 AI 输出重开即变样
  const positiveSafeInt = (f: string) => {
    const v = fields[f]
    if (v !== undefined && !(typeof v === 'number' && Number.isSafeInteger(v) && v > 0)) {
      issues.push(`${f} 须为正整数`)
    }
  }
  switch (nodeType) {
    case 'scene':
      ;['name', 'time', 'weather', 'synopsis'].forEach(str)
      // 引用 id 须 trim 后非空（§8.1 共同值域）：空白引用进画布落盘后会被
      // 加载侧归一化移除——接受的 AI 改动不得重开即变样
      if (
        fields.locationId !== undefined &&
        (typeof fields.locationId !== 'string' || fields.locationId.trim() === '')
      ) {
        issues.push('locationId 须为非空白字符串')
      } else if (typeof fields.locationId === 'string') {
        const refIssue = entityRefIssue(fields.locationId, 'location', 'locationId', entities)
        if (refIssue) issues.push(refIssue)
      }
      positiveSafeInt('sceneNo')
      positiveSafeInt('episodeNo')
      if (fields.interior !== undefined && typeof fields.interior !== 'boolean') {
        issues.push('interior 须为布尔')
      }
      break
    case 'dialogue':
      str('name')
      positiveSafeInt('episodeNo')
      break
    case 'beat':
      str('name')
      str('tone')
      positiveSafeInt('episodeNo')
      break
    case 'branch':
      str('prompt')
      positiveSafeInt('episodeNo')
      break
    case 'shot':
      ;['size', 'picture', 'prompt'].forEach(str)
      positiveSafeInt('shotNo')
      break
    default:
      break
  }
  return issues
}

/** shot.refs 列表的成员校验（S3776 拆解）：返回首见成员问题文案或 null。 */
function shotRefsIssue(refs: unknown, assets: ReadonlyMap<string, string>): string | null {
  if (!Array.isArray(refs)) return 'refs 须为对象数组'
  for (const [i, r] of refs.entries()) {
    const issue = shotRefMemberIssue(r, assets)
    if (issue !== null) return `refs[${i}] ${issue}`
  }
  return null
}

/** 各类型的列表成员值形状（nodeValueShapeError 的分类型明细）。 */
function listShapeIssues(
  nodeType: string,
  fields: Record<string, unknown>,
  assets: ReadonlyMap<string, string>,
  entities?: EntityTokenScope,
): string[] {
  const issues: string[] = []
  if (nodeType === 'scene' && fields.characterIds !== undefined) {
    const arr = fields.characterIds
    // 成员 trim 后非空（§8.1）：空白成员会被加载侧移除，接受的批次重开即变
    if (!Array.isArray(arr) || arr.some((c) => typeof c !== 'string' || c.trim() === '')) {
      issues.push('characterIds 须为非空白字符串数组')
    } else {
      arr.forEach((c, i) => {
        const refIssue = entityRefIssue(c as string, 'character', `characterIds[${i}]`, entities)
        if (refIssue !== null) issues.push(refIssue)
      })
    }
  }
  if (nodeType === 'dialogue' && fields.lines !== undefined) {
    const arr = fields.lines
    const lineIssue = (l: unknown): boolean =>
      !plainObject(l) ||
      typeof l.text !== 'string' ||
      // speaker 须 trim 后非空（§8.1 共同值域）：空白值会被加载侧归一化
      // 移除——接受过的 AI 改动不得重开即变样
      ('speaker' in l && (typeof l.speaker !== 'string' || l.speaker.trim() === '')) ||
      (l.kind !== undefined && l.kind !== 'line' && l.kind !== 'action') ||
      // action 行不得携带 speaker：对白契约只允许 line 行有说话人，放行的
      // 隐藏引用会进活动文档并被持久化
      (l.kind === 'action' && 'speaker' in l) ||
      (l.side !== undefined && l.side !== 'left' && l.side !== 'right') ||
      (l.vo !== undefined && typeof l.vo !== 'boolean')
    if (!Array.isArray(arr) || arr.some(lineIssue)) {
      issues.push('lines 须为对象数组（text 字符串必填；kind ∈ line/action、speaker 仅 line 行可带且非空白字符串、side ∈ left/right、vo 布尔可选）')
    } else {
      arr.forEach((l, i) => {
        if (!plainObject(l) || typeof l.speaker !== 'string') return
        // 缺省 kind 与 normalizeNodeFields 的判别缺省同口径视为 line：
        // 否则无 kind 的台词行绕过 speaker 引用校验，跨种类/悬空说话人
        // 照单进活动文档并被持久化
        if (l.kind !== undefined && l.kind !== 'line') return
        const refIssue = entityRefIssue(l.speaker, 'character', `lines[${i}].speaker`, entities)
        if (refIssue !== null) issues.push(refIssue)
      })
    }
  }
  if (nodeType === 'shot' && fields.refs !== undefined) {
    const issue = shotRefsIssue(fields.refs, assets)
    if (issue !== null) issues.push(issue)
  }
  return issues
}

/** 逐类型载荷值形状校验（信任边界，§9.3/§11.3 的批命令对等）：字段键
 * 白名单只拦未知字段，异型**值**若放行会经 buildCanvasNode 摊进活动节点，
 * 渲染层（ShotNode 的 picture/refs、DialogueNode 的 lines）解引用即崩，
 * 加载归一化来不及兜底。字段存在才校验（patch 局部更新）；null 表示通过。
 * entities（issue 44）：场景/对白对设定集的结构化引用按实体快照解析，
 * 校验存在性与引用类型。 */
export function nodeValueShapeError(
  nodeType: string,
  fields: Record<string, unknown>,
  assets: ReadonlyMap<string, string>,
  entities?: EntityTokenScope,
): string | null {
  const issues = [
    ...scalarShapeIssues(nodeType, fields, entities),
    ...listShapeIssues(nodeType, fields, assets, entities),
  ]
  return issues.length > 0 ? `载荷形状错误：${issues.join('；')}` : null
}
