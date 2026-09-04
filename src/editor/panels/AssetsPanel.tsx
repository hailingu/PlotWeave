import { useEffect, useRef, useState, type ChangeEvent as ReactChangeEvent } from 'react'
import {
  libraryStore,
  LIBRARY_KINDS,
  type LibraryAsset,
  type LibraryKind,
} from '../../library/libraryStore'
import { PW_LIBRARY_ASSET_MIME } from '../dragDrop'
import { EditableName } from '../nodes/settings/NodeSettingsPanel'
import { ConfirmDeleteDialog } from '../../home/Dialogs'

/**
 * 左栏「资产」分段的真实实现（docs/ui-design.md §8.1）：
 * 应用级资产库跨项目复用，按影视美术部门分类——分类列表带计数，
 * 类别内导入（多选图片）/缩略懒加载/行内改名/标签编辑/删除（不可逆，
 * 应用内确认框：原生 window.confirm 在 WKWebView 无 UI 代理、静默
 * 返回 false，打包后点击 ✕ 会毫无反应）。
 * 与项目的流转（§7.3）：缩略图即拖拽把手，拖上画布分镜卡拷贝进项目
 * 并绑定引用位（dragDrop 协议 + useCanvasDrop 承接）。
 */
export default function AssetsPanel() {
  const [assets, setAssets] = useState<LibraryAsset[]>([])
  const [selectedKind, setSelectedKind] = useState<LibraryKind | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const importKind = useRef<LibraryKind>('other')
  /** 缩略图 URL 缓存（懒加载：进入类别才取）。 */
  const [urls, setUrls] = useState<Record<string, string>>({})
  /** 待删除资产（非 null 时弹应用内确认框）。 */
  const [pendingRemove, setPendingRemove] = useState<LibraryAsset | null>(null)

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

  const count = (kind: LibraryKind) => assets.filter((a) => a.kind === kind).length
  const refreshUrl = (asset: LibraryAsset) => {
    libraryStore
      .mediaUrl(asset)
      .then((url) => setUrls((u) => ({ ...u, [asset.id]: url })))
      .catch(() => {})
  }

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

  const commitTags = (asset: LibraryAsset, raw: string) => {
    const tags = raw
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter((t) => t !== '')
    libraryStore
      .updateMeta(asset.id, { tags })
      .catch((err) => setError(String(err)))
  }

  /** 确认后执行：移除列表项并回收缩略 URL；落盘删除交给库门面。
   * 仅在 ConfirmDeleteDialog 确认后调用（删除不可恢复）。 */
  const remove = (asset: LibraryAsset) => {
    setAssets((list) => list.filter((a) => a.id !== asset.id))
    // 回收缩略图 object URL（浏览器预览态），防长会话内存泄漏
    const url = urls[asset.id]
    if (url?.startsWith('blob:')) URL.revokeObjectURL(url)
    setUrls((u) => {
      const next = { ...u }
      delete next[asset.id]
      return next
    })
    libraryStore.remove(asset.id).catch((err) => setError(String(err)))
  }

  return (
    <div className="pw-assets">
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e: ReactChangeEvent<HTMLInputElement>) => void importFiles(e.target.files)}
      />
      {selectedKind === null ? (
        <>
          <div className="pw-assets-hint">个人资产库 · 跨项目</div>
          {LIBRARY_KINDS.map(({ kind, label, icon }) => (
            <div key={kind} className="pw-assets-row pw-assets-row-btn">
              <button
                type="button"
                className="pw-assets-open"
                onClick={() => setSelectedKind(kind)}
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
      ) : (
        <>
          <div className="pw-assets-head">
            <button
              type="button"
              className="pw-assets-back"
              onClick={() => setSelectedKind(null)}
              aria-label="返回分类列表"
            >
              ‹ 分类
            </button>
            <span className="pw-assets-label">
              {LIBRARY_KINDS.find((k) => k.kind === selectedKind)?.label}
            </span>
            <span className="pw-sp" />
            <button
              type="button"
              className="pw-assets-import"
              disabled={busy}
              onClick={() => onPick(selectedKind)}
            >
              ＋ 导入
            </button>
          </div>
          {assets.filter((a) => a.kind === selectedKind).length === 0 && (
            <div className="pw-empty">暂无资产，点击「＋ 导入」添加参考图。</div>
          )}
          {assets
            .filter((a) => a.kind === selectedKind)
            .map((asset) => (
              <AssetRow
                key={asset.id}
                asset={asset}
                url={urls[asset.id]}
                onVisible={refreshUrl}
                onRename={(name) => {
                  setAssets((list) =>
                    list.map((a) => (a.id === asset.id ? { ...a, name } : a)),
                  )
                  void libraryStore.updateMeta(asset.id, { name })
                }}
                onTagsBlur={(raw) => commitTags(asset, raw)}
                onRequestRemove={() => setPendingRemove(asset)}
              />
            ))}
        </>
      )}
      {busy && <div className="pw-assets-hint">导入中…</div>}
      {error && <div className="pw-assets-hint pw-assets-error">{error}</div>}
      {pendingRemove !== null && (
        <ConfirmDeleteDialog
          title="删除资产"
          message={`删除「${pendingRemove.name}」？媒体文件将从资产库移除，此操作不可撤销。`}
          onCancel={() => setPendingRemove(null)}
          onConfirm={() => {
            const target = pendingRemove
            setPendingRemove(null)
            remove(target)
          }}
        />
      )}
    </div>
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
  readonly onTagsBlur: (raw: string) => void
  readonly onRequestRemove: () => void
}) {
  return (
    <div className="pw-asset">
      <AssetThumb asset={asset} url={url} onVisible={onVisible} />
      <div className="pw-asset-body">
        <EditableName value={asset.name} ariaLabel={`资产名 ${asset.name}`} onChange={onRename} />
        <input
          className="pw-asset-tags"
          defaultValue={asset.tags.join('，')}
          placeholder="标签（逗号分隔，可选）"
          aria-label={`资产标签 ${asset.name}`}
          onBlur={(e) => onTagsBlur(e.target.value)}
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
          JSON.stringify({ id: asset.id, name: asset.name, kind: asset.kind, mime: asset.mime }),
        )
        e.dataTransfer.effectAllowed = 'copy'
      }}
    >
      {url ? <img src={url} alt={asset.name} loading="lazy" /> : <span aria-hidden>🖼</span>}
    </div>
  )
}
