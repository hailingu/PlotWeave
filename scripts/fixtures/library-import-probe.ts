/** Test-only bundle entry: real File -> production facade -> production host transport. */
import { IPC_COMMANDS } from '../../src/ipc/commands'
import { ipcInvoke } from '../../src/ipc/invoke'
import { uid } from '../../src/uid'
import { libraryStore } from '../../src/library/libraryStore'

/** Creates a valid uncompressed BMP below the requested legal size; generation precedes timing. */
function image(mebibytes: number): Uint8Array<ArrayBuffer> {
  const width = 2048
  const row = width * 3
  const height = Math.floor((mebibytes * 1024 * 1024 - 54) / row)
  const bytes = new Uint8Array(54 + row * height).fill(91)
  const header = new DataView(bytes.buffer)
  bytes.fill(0, 0, 54)
  bytes[0] = 66
  bytes[1] = 77
  header.setUint32(2, bytes.length, true)
  header.setUint32(10, 54, true)
  header.setUint32(14, 40, true)
  header.setInt32(18, width, true)
  header.setInt32(22, height, true)
  header.setUint16(26, 1, true)
  header.setUint16(28, 24, true)
  header.setUint32(34, row * height, true)
  return bytes
}

/** Records timer/rAF gaps across the complete import, without claiming visual zero-jank acceptance. */
export async function measure(mebibytes: number) {
  const bytes = image(mebibytes)
  const file = new File([bytes], `probe-${mebibytes}.bmp`, {
    type: 'image/bmp',
  })
  await new Promise<void>((resolve) => setTimeout(resolve, 50))
  const start = performance.now()
  let lastTick = start,
    lastFrame = start,
    maxTimerGapMs = 0,
    maxFrameGapMs = 0,
    ticks = 0,
    frames = 0
  const timer = setInterval(() => {
    const now = performance.now()
    maxTimerGapMs = Math.max(maxTimerGapMs, now - lastTick)
    lastTick = now
    ticks++
  }, 8)
  let frame: number
  const animate = () => {
    const now = performance.now()
    maxFrameGapMs = Math.max(maxFrameGapMs, now - lastFrame)
    lastFrame = now
    frames++
    frame = requestAnimationFrame(animate)
  }
  frame = requestAnimationFrame(animate)
  try {
    const asset = await libraryStore.put(file, 'reference')
    const end = performance.now()
    maxTimerGapMs = Math.max(maxTimerGapMs, end - lastTick)
    maxFrameGapMs = Math.max(maxFrameGapMs, end - lastFrame)
    clearInterval(timer)
    cancelAnimationFrame(frame)
    const hash = await crypto.subtle.digest('SHA-256', bytes)
    return {
      visibilityState: document.visibilityState,
      hasFocus: document.hasFocus(),
      bytes: bytes.length,
      elapsedMs: end - start,
      maxTimerGapMs,
      maxFrameGapMs,
      ticks,
      frames,
      asset,
      sha256: Array.from(new Uint8Array(hash), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join(''),
    }
  } finally {
    clearInterval(timer)
    cancelAnimationFrame(frame)
  }
}

/** Exercises an actual rejected final commit while another slot is occupied; both slots remain reusable. */
export async function verifyFailureRecovery(): Promise<void> {
  const first = uid('probe'),
    failed = uid('probe'),
    next = uid('probe')
  const send = (
    uploadId: string,
    total: number,
    kind = 'reference',
    data = 'AQ==',
  ) =>
    ipcInvoke(IPC_COMMANDS.importLibraryAssetChunk, {
      request: {
        uploadId,
        total,
        offset: 0,
        data,
        kind,
        name: 'failure.bmp',
        mime: 'image/bmp',
      },
    })
  try {
    await send(first, 2)
    let refused = false
    try {
      await send(failed, 1, 'invalid')
    } catch {
      refused = true
    }
    if (!refused) throw new Error('invalid final commit was accepted')
    await send(next, 2)
    if ((await libraryStore.list()).length !== 0)
      throw new Error('failed import changed library')
  } finally {
    await send(first, 0, 'reference', '')
    await send(next, 0, 'reference', '')
  }
}
