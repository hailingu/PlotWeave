/**
 * 图片产物与分镜缩略图共用的项目媒体生命周期（#504）：每个挂载独立
 * 请求 URL，身份变化清理状态，清理后的异步结果不得写回当前资源。
 * 只按 projectId/assetId 订阅；调用方保留 asset.id key，保证换绑首帧无旧图。
 */
import { useEffect, useState } from 'react'
import { projectAssets } from '../projectAssets'

/** 读取项目媒体并暴露解析/解码失败态；具体占位、样式与 alt 由节点持有。 */
export function useAssetMedia(projectId: string, assetId: string) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    setUrl(null)
    setFailed(false)
    projectAssets
      .mediaUrl(projectId, assetId)
      .then((value) => {
        if (alive) setUrl(value)
      })
      .catch(() => {
        if (alive) setFailed(true)
      })
    return () => {
      alive = false
    }
  }, [projectId, assetId])
  return { url, failed, reportFailure: () => setFailed(true) }
}
