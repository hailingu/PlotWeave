import { beforeEach, describe, expect, it, vi } from 'vitest'

/** Tauri 会话恢复路径：归一化后的数据与修复写回失败必须一同交给调用方。 */
const invoke = vi.fn<(...args: unknown[]) => Promise<unknown>>()

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
  vi.doMock('@tauri-apps/api/core', () => ({
    invoke: (...args: unknown[]) => invoke(...args),
  }))
  invoke.mockReset()
})

describe('loadAiSession Tauri 路径', () => {
  it('修复后的会话回写失败时保留历史并返回面板可展示的错误', async () => {
    invoke
      .mockResolvedValueOnce({
        schemaVersion: 1,
        entries: [
          { id: 1, kind: 'note', text: '可恢复的历史。' },
          { id: 'bad', kind: 'note', text: '损坏条目。' },
        ],
      })
      .mockRejectedValueOnce(new Error('只读目录'))
    const { loadAiSession } = await import('./aiSessionStore')

    await expect(loadAiSession('p1')).resolves.toEqual({
      session: {
        schemaVersion: 1,
        entries: [{ id: 1, kind: 'note', text: '可恢复的历史。' }],
      },
      repairError: 'Error: 只读目录',
    })
  })
})
