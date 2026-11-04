/** 有界 Web 导入协议：两宿主共用64 KiB帧，最终仍由既有库内核提交。 */
import { uid } from '../uid'
import { createDiagnostic } from '../diagnostics'
import { IPC_COMMANDS } from '../ipc/commands'
import { ipcInvoke } from '../ipc/invoke'

/** 解码后的单帧硬上限；宿主独立执行同一边界。 */
export const LIBRARY_CHUNK_BYTES = 64 * 1024

/** 仅编码当前帧，避免整文件数字数组及JSON；循环不使用可溢栈的参数展开。 */
function encodeChunk(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCodePoint(byte)
  return btoa(binary)
}

/** 顺序发送、校验确认进度；失败只取消临时上传，不自动重试非幂等提交。 */
export async function importLibraryChunks<T>(
  metadata: { name: string; mime: string; kind: string },
  bytes: Uint8Array,
): Promise<T> {
  const uploadId = uid('upload')
  try {
    for (let offset = 0; offset < bytes.length; offset += LIBRARY_CHUNK_BYTES) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      const end = Math.min(offset + LIBRARY_CHUNK_BYTES, bytes.length)
      const result = await ipcInvoke<T & { received?: unknown }>(
        IPC_COMMANDS.importLibraryAssetChunk,
        {
          request: {
            ...metadata,
            uploadId,
            total: bytes.length,
            offset,
            data: encodeChunk(bytes.subarray(offset, end)),
          },
        },
      )
      if (end === bytes.length) return result
      if (result?.received !== end) throw new Error('素材上传进度不一致')
    }
    throw new Error('文件内容为空')
  } catch (error) {
    try {
      await ipcInvoke(IPC_COMMANDS.importLibraryAssetChunk, {
        request: { ...metadata, uploadId, total: 0, offset: 0, data: '' },
      })
    } catch (cleanupError) {
      createDiagnostic(
        'WARN',
        'plotweave::frontend::library',
        'LIBRARY_UPLOAD_ABORT_FAILED',
      )('[Library] 临时上传取消失败；宿主保留有界过期回收', cleanupError)
    }
    throw error
  }
}
