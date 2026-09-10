import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** Tauri 会话路径：单主文件加载、失败可见及串行保存。 */
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
const session = (text: string) => ({
  schemaVersion: 1 as const,
  entries: [{ id: 1, kind: 'note' as const, text }],
})
const payload = { schemaVersion: 1 as const, entries: [] }
/** Rust 主文件加载结果的 IPC 契约。 */
const rec = (session: unknown, corrupt = false) => ({ session, corrupt })

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

// #47 单主文件契约：失败只保留内存，不写恢复副本或定时重试。
describe('saveAiSession 单主文件边界', () => {
  it('主文件失败后错误可见且不会在其他路径持久化或定时重试', async () => {
    vi.useFakeTimers()
    const disk = new Map<string, unknown>()
    invoke.mockImplementation(async (cmd, args) => {
      if (cmd === 'save_ai_session') throw new Error('磁盘已满')
      if (cmd === 'stash_ai_session_recovery') disk.set('recovery', args)
      return rec(null)
    })
    const store = await import('./aiSessionStore')
    await expect(store.saveAiSession('p1', session('未保存消息'))).rejects.toThrow('磁盘已满')
    await vi.advanceTimersByTimeAsync(15000)
    expect(disk.size).toBe(0)
    expect(commandsOf()).toEqual(['save_ai_session'])
    expect(store.hasPendingAiSessionSaves()).toBe(true)
    vi.useRealTimers()
  })

  it('单主文件读取不受恢复目录不可读影响', async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === 'load_ai_session') return rec(session('已保存历史'))
      throw new Error('恢复目录不可用')
    })
    const { loadAiSession } = await import('./aiSessionStore')
    const loaded = await loadAiSession('p1')
    expect(loaded.session).toEqual(session('已保存历史'))
    expect(loaded.repairError).toBeNull()
  })
})

describe('saveAiSession 冲刷固定点排空', () => {
  it('在途保存未落定前视为待处理，冲刷先等它落定', async () => {
    const store = await import('./aiSessionStore')
    let release!: () => void
    invoke.mockImplementation((cmd: unknown) => {
      if (cmd === 'save_ai_session') {
        return new Promise<void>((resolve) => {
          release = () => resolve()
        })
      }
      return Promise.resolve(undefined)
    })

    const saving = store.saveAiSession('p1', payload).catch(() => undefined)
    expect(store.hasPendingAiSessionSaves()).toBe(true)
    // 等待动态导入与 IPC 发起
    await vi.waitFor(() => { expect(typeof release).toBe('function') })
    const flushing = store.flushPendingAiSessionSaves()
    release()
    await saving
    await expect(flushing).resolves.toEqual([])
    expect(store.hasPendingAiSessionSaves()).toBe(false)
  })

  it('冲刷期间新增的保存替换同项目在途项：排空到固定点才返回', async () => {
    const store = await import('./aiSessionStore')
    const gates: Array<() => void> = []
    invoke.mockImplementation((cmd: unknown) => {
      if (cmd === 'save_ai_session') {
        return new Promise<void>((resolve) => { gates.push(() => resolve()) })
      }
      return Promise.resolve(undefined)
    })

    const first = store.saveAiSession('p1', payload).catch(() => undefined)
    await vi.waitFor(() => { expect(gates).toHaveLength(1) })
    // 关闭已被拦截、冲刷正在等第一笔慢保存时用户又改了会话：新保存替换
    // 同项目的在途项（不加入先前捕获的数组），且按写链排在第一笔之后
    const flushing = store.flushPendingAiSessionSaves()
    const second = store.saveAiSession('p1', session('关闭期间的新变更')).catch(() => undefined)
    gates[0]()
    await first
    await vi.waitFor(() => { expect(gates).toHaveLength(2) })

    let flushed = false
    void flushing.then(() => { flushed = true })
    // 第一笔已落定、第二笔仍在途：只等一次快照的冲刷会在此误判已排空
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(flushed).toBe(false)

    gates[1]()
    await second
    await expect(flushing).resolves.toEqual([])
    expect(store.hasPendingAiSessionSaves()).toBe(false)
  })
})


describe('loadAiSession 主文件归一化', () => {
  it('缺文件为空会话，读取不产生保存', async () => {
    invoke.mockResolvedValue(rec(null))
    const store = await import('./aiSessionStore')
    await expect(store.loadAiSession('p1')).resolves.toEqual({ session: payload, repairError: null })
    expect(store.hasPendingAiSessionSaves()).toBe(false)
    expect(commandsOf()).toEqual(['load_ai_session'])
  })

  it('坏条目被隔离，保留其余历史并提示，读盘不修复写回', async () => {
    invoke.mockResolvedValue(rec({
      schemaVersion: 1,
      entries: [{ id: 1, kind: 'note', text: '可用' }, { id: 'bad' }],
    }))
    const store = await import('./aiSessionStore')
    const loaded = await store.loadAiSession('p1')
    expect(loaded.session).toEqual(session('可用'))
    expect(loaded.repairError).toContain('损坏')
    expect(store.hasPendingAiSessionSaves()).toBe(false)
    expect(commandsOf()).toEqual(['load_ai_session'])
  })

  it('文件损坏显示诊断；I/O 读取失败上浮，不当成空文件保存', async () => {
    const store = await import('./aiSessionStore')
    invoke.mockResolvedValueOnce(rec(null, true)).mockRejectedValueOnce(new Error('无法读取'))
    const loaded = await store.loadAiSession('p1')
    expect(loaded.session).toEqual(payload)
    expect(loaded.repairError).toContain('损坏')
    await expect(store.loadAiSession('p2')).rejects.toThrow('无法读取')
    expect(store.hasPendingAiSessionSaves()).toBe(false)
  })
})

describe('saveAiSession 按需重试', () => {
  it('失败后退出仅重试一次，仍失败则保留阻断，后续成功清除', async () => {
    const store = await import('./aiSessionStore')
    invoke.mockRejectedValue(new Error('只读目录'))
    await expect(store.saveAiSession('p1', session('未保存'))).rejects.toThrow('只读目录')
    await expect(store.flushPendingAiSessionSaves()).resolves.toEqual(['p1'])
    expect(commandsOf()).toEqual(['save_ai_session', 'save_ai_session'])
    let disk: unknown
    invoke.mockImplementation(async (_cmd, args) => {
      disk = (args as { session: unknown }).session
    })
    await expect(store.flushPendingAiSessionSaves()).resolves.toEqual([])
    expect(disk).toEqual(session('未保存'))
    expect(store.hasPendingAiSessionSaves()).toBe(false)
  })

  it('只重试最新失败快照，成功通知可退订，删除清除待保存内容', async () => {
    const store = await import('./aiSessionStore')
    const saved: string[] = []
    const unsubscribe = store.onAiSessionSaved((id) => saved.push(id))
    invoke.mockRejectedValue(new Error('只读目录'))
    await expect(store.saveAiSession('p1', session('旧'))).rejects.toThrow()
    await expect(store.saveAiSession('p1', session('新'))).rejects.toThrow()
    let disk: unknown
    invoke.mockImplementation(async (_cmd, args) => { disk = (args as { session: unknown }).session })
    await store.flushPendingAiSessionSaves()
    expect(disk).toEqual(session('新'))
    expect(saved).toEqual(['p1'])
    unsubscribe()
    await store.saveAiSession('p1', session('下一条'))
    expect(saved).toEqual(['p1'])
    invoke.mockRejectedValue(new Error('只读目录'))
    await expect(store.saveAiSession('p1', session('删除前'))).rejects.toThrow()
    store.deleteAiSession('p1')
    await expect(store.flushPendingAiSessionSaves()).resolves.toEqual([])
  })
})
