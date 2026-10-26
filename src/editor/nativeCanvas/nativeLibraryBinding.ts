import { flushSync } from 'react-dom'
import { libraryStore } from '../../library/libraryStore'
import { bindAssetRefPatch, shotRefKindForAsset } from '../assetDrop'
import { projectAssets } from '../projectAssets'
import type { NativeEditorActionOwner } from './nativeEditorOwner'
import type { AssetRef } from '../../model/document'

/** Per-document import admission shares current node identity across native controller rerenders. */
const pending = new WeakMap<object, Set<string>>()

/** Copies an authoritative library asset into a live shot, then atomically records binding and index history. */
export async function nativeLibraryBinding(
  owner: NativeEditorActionOwner,
  args: Record<string, unknown>,
): Promise<null> {
  const nodeId = args.targetNodeId
  if (typeof nodeId !== 'string' || typeof args.assetId !== 'string')
    throw new Error('请选择要添加素材的分镜卡。')
  const { doc, graph, history } = owner.editor
  const locks = pending.get(doc.nodesRef) ?? new Set<string>()
  pending.set(doc.nodesRef, locks)
  if (locks.has(nodeId)) throw new Error('此分镜卡正在导入素材。')
  locks.add(nodeId)
  let unbound: AssetRef | undefined
  let failure: unknown
  try {
    const library = (await libraryStore.list()).find(
      (entry) => entry.id === args.assetId,
    )
    if (!library || library.conflicted)
      throw new Error('库素材已删除或正在恢复。')
    const kind = shotRefKindForAsset(library)
    if (!kind) throw new Error('此素材无法绑定为分镜引用。')
    if (
      owner.isCurrent?.() === false ||
      doc.nodesRef.current.find((node) => node.id === nodeId)?.type !== 'shot'
    )
      throw new Error('分镜目标已失效。')
    const asset = await projectAssets.importFromLibrary(
      owner.project.id,
      library.id,
    )
    unbound = asset
    if (shotRefKindForAsset({ kind: library.kind, mime: asset.mime }) !== kind)
      throw new Error('素材实际类型与分类不符。')
    if (owner.isCurrent?.() === false)
      throw new Error('原项目已关闭，导入结果未绑定。')
    const node = doc.nodesRef.current.find(
      (candidate) => candidate.id === nodeId,
    )
    if (node?.type !== 'shot') throw new Error('分镜已删除，导入结果未绑定。')
    const before = node.data.refs
    const patch = bindAssetRefPatch(before, kind, asset.id)
    if (!patch) return null
    const apply = () => {
      graph.assets.addAsset(asset)
      graph.patch.applyDataPatch(nodeId, { nodeType: 'shot', patch })
    }
    unbound = undefined
    flushSync(() => {
      apply()
      history.push({
        undo: () => {
          graph.assets.removeAsset(asset.id)
          graph.patch.applyDataPatch(nodeId, {
            nodeType: 'shot',
            patch: { refs: before },
          })
        },
        redoGuard: () => projectAssets.revalidate(owner.project.id, asset),
        redo: apply,
      })
    })
    return null
  } catch (error) {
    failure = error
    throw error
  } finally {
    try {
      if (unbound)
        await projectAssets.discardImport(owner.project.id, unbound.id, failure)
    } finally {
      locks.delete(nodeId)
    }
  }
}
