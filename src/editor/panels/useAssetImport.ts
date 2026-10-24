/** 资产库面板的多选导入状态族（AssetsPanel 拆分，issue #719）：批次内逐文件入库、失败不中断、结束汇总。 */
import { useRef, useState } from 'react'
import {
  libraryStore,
  type LibraryAsset,
  type LibraryKind,
} from '../../library/libraryStore'
import { useWebExitAction } from '../../useWebExitAction'

/** 导入与选取状态族（AssetsPanel 拆分，issue #99）：多选导入（逐文件
 * 入库后立即追加并预热缩略）；单个文件失败不中断批次——逐文件捕获、
 * 继续处理剩余文件，结束时汇总（成功 N 个、失败清单点名文件与原因，
 * issue #719），已成功项照常保留；分类选取经隐藏 file input 触发，
 * 不因部分失败重放已成功的 put。 */
export function useAssetImport(
  setAssets: (fn: (list: LibraryAsset[]) => LibraryAsset[]) => void,
  setError: (err: string | null) => void,
  refreshUrl: (asset: LibraryAsset) => void,
  loading: boolean,
) {
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const importKind = useRef<LibraryKind>('other')
  const importFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    if (loading) {
      setError('资产库正在读取，请稍候再导入。')
      if (fileRef.current) fileRef.current.value = ''
      return
    }
    setBusy(true)
    setError(null)
    const kind = importKind.current
    let succeeded = 0
    const failures: string[] = []
    try {
      for (const file of Array.from(files)) {
        try {
          const added = await libraryStore.put(file, kind)
          setAssets((list) => [...list, added])
          refreshUrl(added)
          succeeded += 1
        } catch (err) {
          failures.push(`「${file.name}」失败：${String(err)}`)
        }
      }
      if (failures.length > 0) {
        setError(
          `导入完成：成功 ${succeeded} 个，失败 ${failures.length} 个——${failures.join('；')}`,
        )
      }
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }
  const onPick = (kind: LibraryKind) => {
    importKind.current = kind
    fileRef.current?.click()
  }
  return {
    busy: busy || loading,
    fileRef,
    importFiles: useWebExitAction(importFiles),
    onPick,
  }
}
