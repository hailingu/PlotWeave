import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
} from 'react'
import {
  libraryStore,
  LIBRARY_KINDS,
  type LibraryAsset,
  type LibraryKind,
} from '../../library/libraryStore'
import { PW_LIBRARY_ASSET_MIME } from '../dragDrop'
import { EditableName } from '../nodes/settings/NodeSettingsPanel'
import { ConfirmDeleteDialog } from '../../home/Dialogs'

/** 失焦身份：本轮真实编辑、已提交但仍保留的草稿、无草稿的已保存显示。
 * draft 仅在有未解决失败时用于重试；值相等不代表未编辑。 */
type AssetTagsIntent = 'edit' | 'draft' | 'none'

/**
 * 左栏「资产」分段的真实实现（docs/ui-design.md §8.1）：
 * 应用级资产库跨项目复用，按影视美术部门分类——分类列表带计数，
 * 类别内导入（多选图片）/缩略懒加载/行内改名/标签编辑/删除（不可逆，
 * 应用内确认框：原生 window.confirm 在 WKWebView 无 UI 代理、静默
 * 返回 false，打包后点击 ✕ 会毫无反应）。
 * 与项目的流转（§7.3）：缩略图即拖拽把手，拖上画布分镜卡拷贝进项目
 * 并绑定引用位（dragDrop 协议 + useCanvasDrop 承接）。
 */
/** 资产列表状态族（AssetsPanel 拆分，issue #99）：挂载加载、错误与
 * 缩略 URL 缓存（懒加载：进入类别才取）。 */
function useLibraryAssetList() {
  const [assets, setAssets] = useState<LibraryAsset[]>([])
  const [error, setError] = useState<string | null>(null)
  /** 缩略图 URL 缓存（懒加载：进入类别才取）。 */
  const [urls, setUrls] = useState<Record<string, string>>({})
  useEffect(() => {
    let alive = true
    libraryStore
      .list()
      .then((list) => alive && setAssets(list))
      .catch((err) => alive && setError(String(err)))
    return () => {
      alive = false
    }
  }, [])
  const refreshUrl = (asset: LibraryAsset) => {
    libraryStore
      .mediaUrl(asset)
      .then((url) => setUrls((u) => ({ ...u, [asset.id]: url })))
      .catch(() => {})
  }
  return { assets, setAssets, error, setError, urls, setUrls, refreshUrl }
}

/** 确认后执行删除（AssetsPanel 拆分，issue #99）：移除列表项并回收缩
 * 略 URL（blob: 回收防长会话内存泄漏）；落盘删除交给库门面。仅在
 * ConfirmDeleteDialog 确认后调用（删除不可恢复）。 */
function removeLibraryAsset(
  asset: LibraryAsset,
  urls: Record<string, string>,
  setAssets: (fn: (list: LibraryAsset[]) => LibraryAsset[]) => void,
  setUrls: (fn: (u: Record<string, string>) => Record<string, string>) => void,
  setError: (err: string | null) => void,
): void {
  setAssets((list) => list.filter((a) => a.id !== asset.id))
  const url = urls[asset.id]
  if (url?.startsWith('blob:')) URL.revokeObjectURL(url)
  setUrls((u) => {
    const next = { ...u }
    delete next[asset.id]
    return next
  })
  libraryStore.remove(asset.id).catch((err) => setError(String(err)))
}

/** 删除确认框（AssetsPanel 拆分，issue #99）：✕ 只发起请求，确认后
 * 执行移除并回收缩略 URL；落盘删除交给库门面（删除不可恢复）。 */
function RemoveAssetDialog({
  asset,
  onCancel,
  onConfirm,
}: {
  readonly asset: LibraryAsset
  readonly onCancel: () => void
  readonly onConfirm: (asset: LibraryAsset) => void
}) {
  return (
    <ConfirmDeleteDialog
      title="删除资产"
      message={`删除「${asset.name}」？媒体文件将从资产库移除，此操作不可撤销。`}
      onCancel={onCancel}
      onConfirm={() => onConfirm(asset)}
    />
  )
}

/** 导入与选取状态族（AssetsPanel 拆分，issue #99）：多选导入（逐文件
 * 入库、追加列表并预热缩略）、分类选取经隐藏 file input 触发。 */
function useAssetImport(
  setAssets: (fn: (list: LibraryAsset[]) => LibraryAsset[]) => void,
  setError: (err: string | null) => void,
  refreshUrl: (asset: LibraryAsset) => void,
) {
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const importKind = useRef<LibraryKind>('other')
  const importFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setBusy(true)
    setError(null)
    try {
      const added: LibraryAsset[] = []
      for (const file of Array.from(files)) {
        added.push(await libraryStore.put(file, importKind.current))
      }
      setAssets((list) => [...list, ...added])
      for (const a of added) refreshUrl(a)
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }
  const onPick = (kind: LibraryKind) => {
    importKind.current = kind
    fileRef.current?.click()
  }
  return { busy, fileRef, importFiles, onPick }
}

/** 分类网格（AssetsPanel 拆分，issue #99）：分类入口 + 计数 + 导入。 */
function AssetKindGrid({
  busy,
  count,
  onOpen,
  onPick,
}: {
  readonly busy: boolean
  readonly count: (kind: LibraryKind) => number
  readonly onOpen: (kind: LibraryKind) => void
  readonly onPick: (kind: LibraryKind) => void
}) {
  return (
    <>
      <div className="pw-assets-hint">个人资产库 · 跨项目</div>
      {LIBRARY_KINDS.map(({ kind, label, icon }) => (
        <div key={kind} className="pw-assets-row pw-assets-row-btn">
          <button
            type="button"
            className="pw-assets-open"
            onClick={() => onOpen(kind)}
            title={`查看${label}`}
          >
            <span>{icon}</span>
            <span className="pw-assets-label">{label}</span>
            <span className="pw-sp" />
            <span className="pw-assets-count">{count(kind)}</span>
          </button>
          <button
            type="button"
            className="pw-assets-import"
            aria-label={`导入${label}`}
            title="导入图片到该分类"
            disabled={busy}
            onClick={() => onPick(kind)}
          >
            ＋
          </button>
        </div>
      ))}
    </>
  )
}

/** 类别内资产列表（AssetsPanel 拆分，issue #99）：返回分类、导入与
 * 行级操作（改名/标签/删除请求）。 */
function AssetKindList({
  kind,
  assets,
  urls,
  busy,
  onBack,
  onPick,
  onRename,
  onTagsBlur,
  onRequestRemove,
  onVisible,
}: {
  readonly kind: LibraryKind
  readonly assets: LibraryAsset[]
  readonly urls: Record<string, string>
  readonly busy: boolean
  readonly onBack: () => void
  readonly onPick: (kind: LibraryKind) => void
  readonly onRename: (asset: LibraryAsset, name: string) => void
  readonly onTagsBlur: (
    asset: LibraryAsset,
    raw: string,
    intent: AssetTagsIntent,
  ) => void
  readonly onRequestRemove: (asset: LibraryAsset) => void
  readonly onVisible: (asset: LibraryAsset) => void
}) {
  const items = assets.filter((a) => a.kind === kind)
  return (
    <>
      <div className="pw-assets-head">
        <button
          type="button"
          className="pw-assets-back"
          onClick={onBack}
          aria-label="返回分类列表"
        >
          ‹ 分类
        </button>
        <span className="pw-assets-label">
          {LIBRARY_KINDS.find((k) => k.kind === kind)?.label}
        </span>
        <span className="pw-sp" />
        <button
          type="button"
          className="pw-assets-import"
          disabled={busy}
          onClick={() => onPick(kind)}
        >
          ＋ 导入
        </button>
      </div>
      {items.length === 0 && (
        <div className="pw-empty">暂无资产，点击「＋ 导入」添加参考图。</div>
      )}
      {items.map((asset) => (
        <AssetRow
          key={asset.id}
          asset={asset}
          url={urls[asset.id]}
          onVisible={onVisible}
          onRename={(name) => onRename(asset, name)}
          onTagsBlur={(raw, intent) => onTagsBlur(asset, raw, intent)}
          onRequestRemove={() => onRequestRemove(asset)}
        />
      ))}
    </>
  )
}

/** 解析标签输入（§8.1 标签自由维度）：中英文逗号分隔、去空白、滤空段。 */
function parseAssetTags(raw: string): string[] {
  return raw
    .split(/[,，]/)
    .map((t) => t.trim())
    .filter((t) => t !== '')
}

/** 标签逐项相等（顺序敏感）：未变化的失焦据此跳过写库（issue #124）。 */
function sameTags(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i])
}

/** 成功或只读快照同步只合并 tags，保留并发乐观改名及其他字段。 */
function mergeAssetTags(
  list: LibraryAsset[],
  id: string,
  tags: string[],
): LibraryAsset[] {
  return list.map((asset) => (asset.id === id ? { ...asset, tags } : asset))
}

/** 标签失败的独立状态槽：按资产记录、重试/回退/删除只解除自身，
 * 与导入及删除的共享错误行互不覆盖。 */
function useAssetTagsErrors() {
  const tagsErrors = useRef(new Map<string, string>())
  const [tagsError, setTagsError] = useState<string | null>(null)
  const hasTagsError = (id: string) => tagsErrors.current.has(id)
  const recordTagsError = (id: string, error: unknown) => {
    tagsErrors.current.set(id, String(error))
    setTagsError(joinTagsErrors(tagsErrors.current))
  }
  const resolveTagsError = (id: string) => {
    if (!tagsErrors.current.delete(id)) return
    setTagsError(joinTagsErrors(tagsErrors.current) || null)
  }
  return { tagsError, hasTagsError, recordTagsError, resolveTagsError }
}

/** 标签提交状态族（AssetsPanel 拆分，PR #176 评审）：未变守卫、assetId
 * 级代际计数（迟到旧响应不回滚）、编辑立即进入门面队列（跨挂载保序）、
 * 成功响应字段级合并同步，以及独立的标签错误横幅——按资产
 * 逐个记录未解决失败、自持展示状态，与导入/列表错误分属两行互不覆盖
 * （同文案也不误清）；任一资产成功或无写入的回退（放弃该次修改）都只
 * 解除自身错误，横幅刷新为其余未解决项。 */
function useAssetTagsCommit(
  setAssets: (fn: (list: LibraryAsset[]) => LibraryAsset[]) => void,
) {
  /** 提交代际（issue #124）：assetId → 最新已发起提交的序号。 */
  const tagsCommitSeq = useRef(new Map<string, number>())
  const { tagsError, hasTagsError, recordTagsError, resolveTagsError } =
    useAssetTagsErrors()
  /** 每资产未落定的最新写入目标（在途或已排队）：回退失焦值与本地
   * tags 相同而与它不同时，必须把回退排队写在其后（PR #176 评审，P1）。 */
  const pendingTags = useRef(new Map<string, string[]>())

  /** 确认删除时终结该行标签编辑：失效在途响应，并解除该资产的错误。 */
  const forgetTags = (id: string) => {
    tagsCommitSeq.current.set(id, (tagsCommitSeq.current.get(id) ?? 0) + 1)
    pendingTags.current.delete(id)
    resolveTagsError(id)
  }

  /** 排队一次标签写入：立即进入门面队列 + 代际守卫取用响应；成功只合并
   * tags 字段并解除自身错误，失败逐资产记录。 */
  const enqueueTagsCommit = (assetId: string, tags: string[]) => {
    const seq = (tagsCommitSeq.current.get(assetId) ?? 0) + 1
    tagsCommitSeq.current.set(assetId, seq)
    pendingTags.current.set(assetId, tags)
    libraryStore
      .updateMeta(assetId, { tags })
      .then((updated) => {
        // 持久化基线由门面快照推进（跨挂载共享）：被取代的成功也落盘
        if (tagsCommitSeq.current.get(assetId) !== seq) return
        pendingTags.current.delete(assetId)
        resolveTagsError(assetId)
        setAssets((list) => mergeAssetTags(list, assetId, updated.tags))
      })
      .catch((err) => {
        // 失败保留输入并逐资产记录；被取代的旧失败不再上报（代际守卫）
        if (tagsCommitSeq.current.get(assetId) !== seq) return
        pendingTags.current.delete(assetId)
        recordTagsError(assetId, err)
      })
  }

  const commitTags = (
    asset: LibraryAsset,
    raw: string,
    intent: AssetTagsIntent,
  ) => {
    const tags = parseAssetTags(raw)
    const pending = pendingTags.current.get(asset.id)
    const persisted = libraryStore.persistedSnapshot(asset.id)?.tags
    // 无本轮编辑只允许保留的失败草稿重试；陈旧显示只读同步，不能回写。
    if (intent !== 'edit' && !(intent === 'draft' && hasTagsError(asset.id))) {
      if (pending === undefined && persisted) {
        setAssets((list) => mergeAssetTags(list, asset.id, persisted))
      }
      return
    }
    // 真实回退还须排在旧挂载的更新后，不能只检查当前 hook 的 pending。
    if (
      sameTags(tags, asset.tags) &&
      sameTags(tags, persisted ?? asset.tags) &&
      !libraryStore.hasPendingOperation(asset.id) &&
      (pending === undefined || sameTags(pending, tags))
    ) {
      resolveTagsError(asset.id)
      return
    }
    enqueueTagsCommit(asset.id, tags)
  }
  return { commitTags, tagsError, forgetTags }
}

/** 重命名提交状态族（AssetsPanel 拆分，PR #180 评审修复超限）：乐观
 * 更新 + 失败回滚 + 代际守卫 + 专属错误行。
 * - 代际（每资产递增序号，非名称值）：被新意图取代的迟到失败静默——
 *   A→B→C→B 同名往返不得误判（快速连续改名按最新意图收敛）。
 * - 基线：失败回滚优先读门面跨挂载推进的 persistedSnapshot（面板重挂载
 *   期间旧实例的排队写入可能已把磁盘推进到新于本地锚点的值），本地
 *   锚点兜底——链条首个未决改名发起时锚定（中途意图的 prop 名是乐观
 *   值，不得当基线），成功按该次落盘名推进（门面按资产 FIFO，最终成功
 *   即磁盘真值），失败回滚消费后清除。
 * - 错误：重命名专属行（与导入/列表/标签错误互不覆盖），同资产重试
 *   成功即解除，不误清其他操作的错误。
 * 不做重试或草稿暂存，用户可重新发起改名（#125）。 */
function useAssetRename(
  setAssets: (fn: (list: LibraryAsset[]) => LibraryAsset[]) => void,
) {
  /** 每资产最近发起的重命名代际序号。 */
  const renameSeq = useRef(new Map<string, number>())
  /** 每资产未决改名链条锚定的已落盘基线。 */
  const renameBaseline = useRef(new Map<string, string>())
  const [renameError, setRenameError] = useState<{
    id: string
    message: string
  } | null>(null)

  const rename = (asset: LibraryAsset, name: string) => {
    const seq = (renameSeq.current.get(asset.id) ?? 0) + 1
    renameSeq.current.set(asset.id, seq)
    if (!renameBaseline.current.has(asset.id)) {
      renameBaseline.current.set(
        asset.id,
        libraryStore.persistedSnapshot(asset.id)?.name ?? asset.name,
      )
    }
    setAssets((list) =>
      list.map((a) => (a.id === asset.id ? { ...a, name } : a)),
    )
    libraryStore
      .updateMeta(asset.id, { name })
      .then(() => {
        renameBaseline.current.set(asset.id, name)
        setRenameError((cur) => (cur?.id === asset.id ? null : cur))
      })
      .catch((err) => {
        if (renameSeq.current.get(asset.id) !== seq) return
        // 跨挂载真值优先：重挂载期间旧实例排队写入可能已把快照推进到
        // 新于本地锚点的值（PR #180 评审修复）
        const baseline =
          libraryStore.persistedSnapshot(asset.id)?.name ??
          renameBaseline.current.get(asset.id)
        renameBaseline.current.delete(asset.id)
        setRenameError({ id: asset.id, message: String(err) })
        setAssets((list) =>
          list.map((a) =>
            a.id === asset.id && baseline !== undefined
              ? { ...a, name: baseline }
              : a,
          ),
        )
      })
  }
  /** 确认删除时终结该资产的重命名状态（PR #180 评审修复）：代际 +1
   * 失效在途响应（迟到的失败不写错误、不回滚），清除锚定基线并解除
   * 对应错误——已删资产的失败不得残留或复活。 */
  const forgetRename = (id: string) => {
    renameSeq.current.set(id, (renameSeq.current.get(id) ?? 0) + 1)
    renameBaseline.current.delete(id)
    setRenameError((cur) => (cur?.id === id ? null : cur))
  }
  return { rename, renameError, forgetRename }
}

/** 把各资产未解决的标签失败合并为单条横幅文案（分号分隔）。 */
function joinTagsErrors(errors: Map<string, string>): string {
  return [...errors.values()].join('；')
}

export default function AssetsPanel() {
  const { assets, setAssets, error, setError, urls, setUrls, refreshUrl } =
    useLibraryAssetList()
  const [selectedKind, setSelectedKind] = useState<LibraryKind | null>(null)
  /** 待删除资产（非 null 时弹应用内确认框）。 */
  const [pendingRemove, setPendingRemove] = useState<LibraryAsset | null>(null)
  const count = (kind: LibraryKind) =>
    assets.filter((a) => a.kind === kind).length
  const { busy, fileRef, importFiles, onPick } = useAssetImport(
    setAssets,
    setError,
    refreshUrl,
  )
  const { commitTags, tagsError, forgetTags } = useAssetTagsCommit(setAssets)
  const { rename, renameError, forgetRename } = useAssetRename(setAssets)

  const remove = (asset: LibraryAsset) => {
    forgetTags(asset.id)
    forgetRename(asset.id)
    removeLibraryAsset(asset, urls, setAssets, setUrls, setError)
  }

  return (
    <div className="pw-assets">
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e: ReactChangeEvent<HTMLInputElement>) =>
          void importFiles(e.target.files)
        }
      />
      {selectedKind === null ? (
        <AssetKindGrid
          busy={busy}
          count={count}
          onOpen={setSelectedKind}
          onPick={onPick}
        />
      ) : (
        <AssetKindList
          kind={selectedKind}
          assets={assets}
          urls={urls}
          busy={busy}
          onBack={() => setSelectedKind(null)}
          onPick={onPick}
          onVisible={refreshUrl}
          onRename={rename}
          onTagsBlur={commitTags}
          onRequestRemove={setPendingRemove}
        />
      )}
      {busy && <div className="pw-assets-hint">导入中…</div>}
      {error && <div className="pw-assets-hint pw-assets-error">{error}</div>}
      {renameError && (
        <div className="pw-assets-hint pw-assets-error">
          {renameError.message}
        </div>
      )}
      {tagsError && (
        <div className="pw-assets-hint pw-assets-error">{tagsError}</div>
      )}
      {pendingRemove !== null && (
        <RemoveAssetDialog
          asset={pendingRemove}
          onCancel={() => setPendingRemove(null)}
          onConfirm={(target) => {
            setPendingRemove(null)
            remove(target)
          }}
        />
      )}
    </div>
  )
}

/** 标签输入（issue #124）：受控草稿 + 跟随已保存值收敛。已保存 tags 变化
 * 落地（提交成功同步、迟到响应）时，无未提交编辑（!dirty）的输入框显示
 * 收敛到新值，堵住「重挂载显示陈旧值 + 未编辑失焦回写」的窗口；编辑中
 * （含提交后在响应到达前改回旧值的撤回）以显式 dirty 标记保护，迟到的
 * 保存响应不抢占草稿（PR #176 评审：不得以「草稿恰好等于旧保存值」推断
 * 未编辑）；失败未同步则草稿保留，用户输入不丢。失焦携带编辑/草稿
 * 身份，上层仅对本轮编辑或未解决失败的保留草稿判断写入。 */
function AssetTagsInput({
  tags,
  ariaLabel,
  onCommit,
}: {
  readonly tags: string[]
  readonly ariaLabel: string
  readonly onCommit: (raw: string, intent: AssetTagsIntent) => void
}) {
  const saved = tags.join('，')
  /** null = 无草稿，显示跟随已保存值。 */
  const [draft, setDraft] = useState<string | null>(null)
  /** 编辑中：失焦提交后为 false（已保存值变化可收敛显示），true 不抢占。 */
  const [dirty, setDirty] = useState(false)
  const [prevSaved, setPrevSaved] = useState(saved)
  if (saved !== prevSaved) {
    setPrevSaved(saved)
    if (!dirty) setDraft(null)
  }
  return (
    <input
      className="pw-asset-tags"
      value={draft ?? saved}
      placeholder="标签（逗号分隔，可选）"
      aria-label={ariaLabel}
      onChange={(e) => {
        setDraft(e.target.value)
        setDirty(true)
      }}
      onBlur={(e) => {
        const unchangedIntent = draft === null ? 'none' : 'draft'
        onCommit(e.target.value, dirty ? 'edit' : unchangedIntent)
        setDirty(false)
      }}
    />
  )
}

/** 类别内一行资产：缩略（懒加载 + 拖拽把手）+ 行内改名/标签 + 删除入口。
 * 删除不可逆，✕ 只发起请求，由父级弹 ConfirmDeleteDialog 确认后执行。 */
function AssetRow({
  asset,
  url,
  onVisible,
  onRename,
  onTagsBlur,
  onRequestRemove,
}: {
  readonly asset: LibraryAsset
  readonly url?: string
  readonly onVisible: (asset: LibraryAsset) => void
  readonly onRename: (name: string) => void
  readonly onTagsBlur: (raw: string, intent: AssetTagsIntent) => void
  readonly onRequestRemove: () => void
}) {
  return (
    <div className="pw-asset">
      <AssetThumb asset={asset} url={url} onVisible={onVisible} />
      <div className="pw-asset-body">
        <EditableName
          value={asset.name}
          ariaLabel={`资产名 ${asset.name}`}
          onChange={onRename}
        />
        <AssetTagsInput
          tags={asset.tags}
          ariaLabel={`资产标签 ${asset.name}`}
          onCommit={onTagsBlur}
        />
      </div>
      <button
        type="button"
        className="pw-settings-x"
        aria-label={`删除资产 ${asset.name}`}
        title="删除（不可恢复）"
        onClick={onRequestRemove}
      >
        ✕
      </button>
    </div>
  )
}

/** 缩略图：懒加载（进入视口/进入类别才解析媒体 URL）。同时是拖上画布
 * 的把手（§7.3 库资产拖上画布 = 拷贝进项目）——只在缩略图上开拖拽，
 * 避免容器拖拽与行内输入框（改名/标签）的文本选择冲突。 */
function AssetThumb({
  asset,
  url,
  onVisible,
}: {
  readonly asset: LibraryAsset
  readonly url?: string
  readonly onVisible: (asset: LibraryAsset) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (url) return
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((en) => en.isIntersecting)) {
          onVisible(asset)
          io.disconnect()
        }
      },
      { root: el.closest('.pw-panel-scroll'), rootMargin: '80px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [asset, onVisible, url])
  return (
    <div
      ref={ref}
      className="pw-asset-thumb"
      draggable
      title="拖上画布分镜卡：拷贝进项目并绑定引用位"
      onDragStart={(e) => {
        e.dataTransfer.setData(
          PW_LIBRARY_ASSET_MIME,
          JSON.stringify({
            id: asset.id,
            name: asset.name,
            kind: asset.kind,
            mime: asset.mime,
          }),
        )
        e.dataTransfer.effectAllowed = 'copy'
      }}
    >
      {url ? (
        <img src={url} alt={asset.name} loading="lazy" />
      ) : (
        <span aria-hidden>🖼</span>
      )}
    </div>
  )
}
