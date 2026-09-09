import { beforeEach, describe, expect, it, vi } from 'vitest'

/** Tauri 会话路径：恢复副本优先、修复写回失败上报、保存失败先写恢复副本。 */
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
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        schemaVersion: 1,
        entries: [
          { id: 1, kind: 'note', text: '可恢复的历史。' },
          { id: 'bad', kind: 'note', text: '损坏条目。' },
        ],
      })
      .mockRejectedValueOnce(new Error('只读目录'))
      .mockResolvedValueOnce(undefined)
    const { loadAiSession } = await import('./aiSessionStore')

    await expect(loadAiSession('p1')).resolves.toEqual({
      session: {
        schemaVersion: 1,
        entries: [{ id: 1, kind: 'note', text: '可恢复的历史。' }],
      },
      repairError: 'Error: 只读目录',
      recovered: false,
    })
  })

  it('恢复副本优先于权威文件并尝试提升；提升失败时如实标记 recovered', async () => {
    const session = {
      schemaVersion: 1,
      entries: [{ id: 1, kind: 'note', text: '恢复副本' }],
    }
    invoke
      .mockResolvedValueOnce(session)
      .mockRejectedValueOnce(new Error('磁盘已满'))
      .mockResolvedValueOnce(undefined)
    const { loadAiSession } = await import('./aiSessionStore')

    await expect(loadAiSession('p1')).resolves.toEqual({
      session,
      repairError: 'Error: 磁盘已满',
      recovered: true,
    })
    // 有恢复副本时不再读权威文件（它一定是更旧的失败前状态）
    expect(invoke.mock.calls.map((call) => call[0])).toEqual([
      'load_ai_session_recovery',
      'save_ai_session',
      'stash_ai_session_recovery',
    ])
  })

  it('恢复副本提升成功后不再标记 recovered（权威文件已恢复）', async () => {
    const session = {
      schemaVersion: 1,
      entries: [{ id: 1, kind: 'note', text: '恢复副本' }],
    }
    invoke.mockResolvedValueOnce(session).mockResolvedValueOnce(undefined)
    const { loadAiSession } = await import('./aiSessionStore')

    await expect(loadAiSession('p1')).resolves.toEqual({
      session,
      repairError: null,
      recovered: false,
    })
    expect(invoke.mock.calls.map((call) => call[0])).toEqual([
      'load_ai_session_recovery',
      'save_ai_session',
    ])
  })

  it('恢复副本读取失败时回退权威会话文件，不阻断会话加载', async () => {
    const session = {
      schemaVersion: 1,
      entries: [{ id: 1, kind: 'note', text: '权威文件' }],
    }
    invoke.mockRejectedValueOnce(new Error('恢复副本损坏')).mockResolvedValueOnce(session)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { loadAiSession } = await import('./aiSessionStore')

    await expect(loadAiSession('p1')).resolves.toEqual({
      session,
      repairError: null,
      recovered: false,
    })
    expect(invoke.mock.calls.map((call) => call[0])).toEqual([
      'load_ai_session_recovery',
      'load_ai_session',
    ])
    warn.mockRestore()
  })
})

describe('saveAiSession Tauri 路径', () => {
  const session = { schemaVersion: 1 as const, entries: [] }

  it('保存失败先尽力写恢复副本再上抛（内存副本不再是唯一拷贝）', async () => {
    invoke.mockRejectedValueOnce(new Error('磁盘已满')).mockResolvedValueOnce(undefined)
    const { saveAiSession } = await import('./aiSessionStore')

    await expect(saveAiSession('p1', session)).rejects.toThrow('磁盘已满')
    expect(invoke.mock.calls[1]).toEqual(['stash_ai_session_recovery', { id: 'p1', session }])
  })

  it('恢复副本也写失败时仍上抛原始错误（内存副本保留待重试）', async () => {
    invoke
      .mockRejectedValueOnce(new Error('磁盘已满'))
      .mockRejectedValueOnce(new Error('恢复目录只读'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { saveAiSession } = await import('./aiSessionStore')

    await expect(saveAiSession('p1', session)).rejects.toThrow('磁盘已满')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
