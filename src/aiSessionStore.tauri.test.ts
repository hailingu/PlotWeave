import { beforeEach, describe, expect, it, vi } from 'vitest'

/** Tauri 会话路径：主/副本按写入时刻取新、修复写回失败上报、保存失败在链内写副本。 */
const invoke = vi.fn<(...args: unknown[]) => Promise<unknown>>()

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
  vi.doMock('@tauri-apps/api/core', () => ({
    invoke: (...args: unknown[]) => invoke(...args),
  }))
  invoke.mockReset()
})

const commandsOf = () => invoke.mock.calls.map((call) => call[0])
const session = (text: string, savedAt?: number) => ({
  schemaVersion: 1,
  entries: [{ id: 1, kind: 'note', text }],
  ...(savedAt !== undefined ? { savedAt } : {}),
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
      .mockResolvedValueOnce(null)
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
    expect(commandsOf()).toEqual([
      'load_ai_session',
      'load_ai_session_recovery',
      'save_ai_session',
      'stash_ai_session_recovery',
    ])
  })

  it('恢复副本写入时刻更新时优先，并尝试提升；提升失败如实标记 recovered', async () => {
    invoke
      .mockResolvedValueOnce(session('旧权威', 100))
      .mockResolvedValueOnce(session('恢复副本', 200))
      .mockRejectedValueOnce(new Error('磁盘已满'))
      .mockResolvedValueOnce(undefined)
    const { loadAiSession } = await import('./aiSessionStore')

    await expect(loadAiSession('p1')).resolves.toEqual({
      session: session('恢复副本'),
      repairError: 'Error: 磁盘已满',
      recovered: true,
    })
  })

  it('恢复副本提升成功后不再标记 recovered（权威文件已恢复）', async () => {
    invoke
      .mockResolvedValueOnce(session('旧权威', 100))
      .mockResolvedValueOnce(session('恢复副本', 200))
      .mockResolvedValueOnce(undefined)
    const { loadAiSession } = await import('./aiSessionStore')

    await expect(loadAiSession('p1')).resolves.toEqual({
      session: session('恢复副本'),
      repairError: null,
      recovered: false,
    })
  })

  it('陈旧恢复副本不得压过较新的权威文件（清除失败后的回退保护）', async () => {
    invoke.mockResolvedValueOnce(session('新权威', 200)).mockResolvedValueOnce(session('陈旧副本', 100))
    const { loadAiSession } = await import('./aiSessionStore')

    await expect(loadAiSession('p1')).resolves.toEqual({
      session: session('新权威'),
      repairError: null,
      recovered: false,
    })
    expect(commandsOf()).toEqual(['load_ai_session', 'load_ai_session_recovery'])
  })

  it('权威文件损坏时回退恢复副本；两者都不可用时上浮原始错误', async () => {
    invoke
      .mockRejectedValueOnce(new Error('AI 会话文件损坏'))
      .mockResolvedValueOnce(session('恢复副本', 200))
      .mockResolvedValueOnce(undefined)
    const { loadAiSession } = await import('./aiSessionStore')
    await expect(loadAiSession('p1')).resolves.toEqual({
      session: session('恢复副本'),
      repairError: null,
      recovered: false,
    })

    invoke.mockReset()
    invoke
      .mockRejectedValueOnce(new Error('AI 会话文件损坏'))
      .mockResolvedValueOnce(null)
    await expect(loadAiSession('p1')).rejects.toThrow('AI 会话文件损坏')
  })

  it('恢复副本读取失败时回退权威会话文件，不阻断会话加载', async () => {
    invoke
      .mockResolvedValueOnce(session('权威文件', 200))
      .mockRejectedValueOnce(new Error('恢复副本损坏'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { loadAiSession } = await import('./aiSessionStore')

    await expect(loadAiSession('p1')).resolves.toEqual({
      session: session('权威文件'),
      repairError: null,
      recovered: false,
    })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('saveAiSession Tauri 路径', () => {
  const payload = { schemaVersion: 1 as const, entries: [] }

  it('保存失败在写链内先尽力写恢复副本再上抛（副本带写入时刻）', async () => {
    invoke.mockRejectedValueOnce(new Error('磁盘已满')).mockResolvedValueOnce(undefined)
    const { saveAiSession } = await import('./aiSessionStore')

    await expect(saveAiSession('p1', payload)).rejects.toThrow('磁盘已满')
    expect(commandsOf()).toEqual(['save_ai_session', 'stash_ai_session_recovery'])
    const stash = invoke.mock.calls[1][1] as { session: { savedAt: number } }
    expect(typeof stash.session.savedAt).toBe('number')
  })

  it('恢复副本也写失败时仍上抛原始错误（内存副本保留待重试）', async () => {
    invoke
      .mockRejectedValueOnce(new Error('磁盘已满'))
      .mockRejectedValueOnce(new Error('恢复目录只读'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { saveAiSession } = await import('./aiSessionStore')

    await expect(saveAiSession('p1', payload)).rejects.toThrow('磁盘已满')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('恢复副本写入属于同一项目写链：链上后续动作必须等副本写完', async () => {
    let releaseStash!: () => void
    invoke.mockImplementation((cmd: unknown) => {
      if (cmd === 'save_ai_session') return Promise.reject(new Error('磁盘已满'))
      if (cmd === 'stash_ai_session_recovery') {
        return new Promise<void>((resolve) => { releaseStash = resolve })
      }
      return Promise.resolve()
    })
    const { saveAiSession } = await import('./aiSessionStore')
    const { enqueueProjectWrite } = await import('./projectStore/saveChain')

    const save = saveAiSession('p1', payload).catch(() => undefined)
    let secondStarted = false
    const second = enqueueProjectWrite('p1', async () => { secondStarted = true })
    // 等副本写入发起（动态 import 引入额外节拍）
    await vi.waitFor(() => { expect(typeof releaseStash).toBe('function') })
    // 副本写入未落定前，链上后续动作不得开始（旧实现会把副本写在链外）
    expect(secondStarted).toBe(false)
    releaseStash()
    await save
    await second
    expect(secondStarted).toBe(true)
  })
})
