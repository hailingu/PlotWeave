/** Asset-panel thumbnail handles and asynchronous receipts share one mounted resource owner. */
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { libraryStore, type LibraryAsset } from '../../library/libraryStore'

/** Opaque host URLs have no JS-owned blob; browser-preview resources are released explicitly. */
function releaseThumbnail(url: string | undefined): void {
  if (url?.startsWith('blob:')) URL.revokeObjectURL(url)
}

/** Keep unchanged records stable while removing only the target asset's presentation state. */
function withoutAsset(
  record: Record<string, string>,
  id: string,
): Record<string, string> {
  if (!(id in record)) return record
  const next = { ...record }
  delete next[id]
  return next
}

/** One mounted panel owns URL handles and request identities; deleted/detached requests can only release their result. */
export function useAssetThumbnails() {
  const [urls, setUrls] = useState<Record<string, string>>({})
  const [thumbErrors, setThumbErrors] = useState<Record<string, string>>({})
  const pending = useRef(new Map<string, object>())
  const live = useRef(new Map<string, string>())
  const mounted = useRef(true)
  useLayoutEffect(() => {
    const requests = pending.current
    const handles = live.current
    mounted.current = true
    return () => {
      mounted.current = false
      requests.clear()
      handles.forEach(releaseThumbnail)
      handles.clear()
    }
  }, [])
  const refreshUrl = useCallback((asset: LibraryAsset) => {
    if (!mounted.current || pending.current.has(asset.id)) return
    const token = {}
    pending.current.set(asset.id, token)
    libraryStore
      .mediaUrl(asset)
      .then((url) => {
        if (pending.current.get(asset.id) !== token) {
          releaseThumbnail(url)
          return
        }
        const previous = live.current.get(asset.id)
        if (previous !== url) releaseThumbnail(previous)
        live.current.set(asset.id, url)
        setUrls((current) => ({ ...current, [asset.id]: url }))
        setThumbErrors((current) => withoutAsset(current, asset.id))
      })
      .catch((error) => {
        if (pending.current.get(asset.id) === token) {
          setThumbErrors((current) => ({
            ...current,
            [asset.id]: String(error),
          }))
        }
      })
      .finally(() => {
        if (pending.current.get(asset.id) === token)
          pending.current.delete(asset.id)
      })
  }, [])
  const forgetUrl = useCallback((id: string) => {
    pending.current.delete(id)
    releaseThumbnail(live.current.get(id))
    live.current.delete(id)
    setUrls((current) => withoutAsset(current, id))
    setThumbErrors((current) => withoutAsset(current, id))
  }, [])
  return { urls, thumbErrors, refreshUrl, forgetUrl }
}
