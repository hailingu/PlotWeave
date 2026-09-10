import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
const session = (text: string, writeSeq?: number) => ({
  schemaVersion: 1 as const,
  entries: [{ id: 1, kind: 'note' as const, text }],
  ...(writeSeq !== undefined ? { writeSeq } : {}),
})
const payload = { schemaVersion: 1 as const, entries: [] }
/** `load_ai_session_recovery` 的 RecoveryCopy 契约：session 为 null 表示
 * 缺失或损坏（损坏时 corrupt 置位——按可安全替换归类）。 */
const rec = (session: unknown, corrupt = false) => ({ session, corrupt })

describe('loadAiSession Tauri 路径 · 副本取新与提升', () => {
  it('修复后的会话回写失败时保留历史并返回面板可展示的错误', async () => {
    invoke
      .mockResolvedValueOnce(
        rec({
          schemaVersion: 1,
          entries: [
            { id: 1, kind: 'note', text: '可恢复的历史。' },
            { id: 'bad', kind: 'note', text: '损坏条目。' },
          ],
        }),
      )
      .mockResolvedValueOnce(rec(null))
      .mockRejectedValueOnce(new Error('只读目录'))
      // 冲突检测重读（序号 0 → 真实失败）
      .mockResolvedValueOnce(rec(null))
      .mockResolvedValueOnce(rec(null))
      .mockResolvedValueOnce(undefined)
    const { loadAiSession } = await import('./aiSessionStore')

    await expect(loadAiSession('p1')).resolves.toEqual({
      session: {
        schemaVersion: 1,
        entries: [{ id: 1, kind: 'note', text: '可恢复的历史。' }],
      },
      repairError: 'Error: 只读目录',
      recovered: false,
      recoveryUnreadable: false,
      authoritativeUnreadable: false,
    })
    expect(commandsOf()).toEqual([
      'load_ai_session',
      'load_ai_session_recovery',
      'save_ai_session',
      'load_ai_session',
      'load_ai_session_recovery',
      'stash_ai_session_recovery',
    ])
  })

  it('恢复副本写入序号更大时优先，并尝试提升；提升失败如实标记 recovered', async () => {
    invoke
      .mockResolvedValueOnce(rec(session('旧权威', 100)))
      .mockResolvedValueOnce(rec(session('恢复副本', 200)))
      .mockRejectedValueOnce(new Error('磁盘已满'))
      // 冲突检测重读（磁盘最大序号 200 < 本次写入 201 → 真实失败）
      .mockResolvedValueOnce(rec(session('旧权威', 100)))
      .mockResolvedValueOnce(rec(session('恢复副本', 200)))
      .mockResolvedValueOnce(undefined)
    const { loadAiSession } = await import('./aiSessionStore')

    await expect(loadAiSession('p1')).resolves.toEqual({
      session: session('恢复副本'),
      repairError: 'Error: 磁盘已满',
      recovered: true,
      recoveryUnreadable: false,
      authoritativeUnreadable: false,
    })
  })

  it('恢复副本提升成功后不再标记 recovered（权威文件已恢复）', async () => {
    invoke
      .mockResolvedValueOnce(rec(session('旧权威', 100)))
      .mockResolvedValueOnce(rec(session('恢复副本', 200)))
      .mockResolvedValueOnce(undefined)
    const { loadAiSession } = await import('./aiSessionStore')

    await expect(loadAiSession('p1')).resolves.toEqual({
      session: session('恢复副本'),
      repairError: null,
      recovered: false,
      recoveryUnreadable: false,
      authoritativeUnreadable: false,
    })
  })

  it('陈旧恢复副本不得压过序号更大的权威文件（清除失败后的回退保护）', async () => {
    invoke
      .mockResolvedValueOnce(rec(session('新权威', 200)))
      .mockResolvedValueOnce(rec(session('陈旧副本', 100)))
    const { loadAiSession } = await import('./aiSessionStore')

    await expect(loadAiSession('p1')).resolves.toEqual({
      session: session('新权威'),
      repairError: null,
      recovered: false,
      recoveryUnreadable: false,
      authoritativeUnreadable: false,
    })
    expect(commandsOf()).toEqual(['load_ai_session', 'load_ai_session_recovery'])
  })
})

describe('loadAiSession Tauri 路径 · 读取失败回退', () => {
  it('权威文件不可读时展示恢复副本并暂缓写回（不发起保存/登记重试）', async () => {
    invoke
      .mockRejectedValueOnce(new Error('权限拒绝'))
      .mockResolvedValueOnce(rec(session('恢复副本', 200)))
    const { loadAiSession, hasPendingAiSessionSaves } = await import('./aiSessionStore')

    const result = await loadAiSession('p1')
    expect(result.session.entries[0].text).toBe('恢复副本')
    expect(result.recovered).toBe(true)
    expect(result.recoveryUnreadable).toBe(false)
    expect(result.authoritativeUnreadable).toBe(true)
    expect(result.repairError).toContain('权限拒绝')
    // 不发起提升/修复写回：保存失败路径会把（可能陈旧的）恢复内容带递增
    // 序号写回副本并登记重试，权威文件恢复可读后陈旧历史将覆盖更新的
    // 权威会话；也不得有重试登记残留
    expect(commandsOf()).toEqual(['load_ai_session', 'load_ai_session_recovery'])
    expect(hasPendingAiSessionSaves()).toBe(false)
  })

  it('权威文件损坏时回退恢复副本并提升修复（不进门禁）；真实 I/O 不可读且无副本才上浮', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    invoke
      .mockResolvedValueOnce(rec(null, true))
      .mockResolvedValueOnce(rec(session('恢复副本', 200)))
      .mockResolvedValueOnce(undefined)
    const { loadAiSession } = await import('./aiSessionStore')
    // 主文件损坏（不可解析，可安全替换）：恢复副本胜出并立即提升写回——
    // 写入边界按可替换覆盖修复主文件，不进新旧未知门禁
    await expect(loadAiSession('p1')).resolves.toEqual({
      session: session('恢复副本'),
      repairError: null,
      recovered: false,
      recoveryUnreadable: false,
      authoritativeUnreadable: false,
    })
    expect(commandsOf()).toEqual([
      'load_ai_session',
      'load_ai_session_recovery',
      'save_ai_session',
    ])
    warn.mockRestore()

    // 真实 I/O 不可读（权限/瞬态 I/O）且无可用恢复副本：显式上浮原始错误
    invoke.mockReset()
    invoke.mockRejectedValueOnce(new Error('权限拒绝')).mockResolvedValueOnce(rec(null))
    await expect(loadAiSession('p1')).rejects.toThrow('权限拒绝')
  })

  it('恢复副本不可读时展示权威历史并标记暂缓保存（不发起提升）', async () => {
    invoke
      .mockResolvedValueOnce(rec(session('权威历史', 5)))
      .mockRejectedValueOnce(new Error('权限拒绝'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { loadAiSession } = await import('./aiSessionStore')

    const result = await loadAiSession('p1')
    expect(result.session.entries[0].text).toBe('权威历史')
    expect(result.recovered).toBe(false)
    expect(result.recoveryUnreadable).toBe(true)
    expect(result.repairError).toContain('恢复副本读取失败')
    // 不尝试提升/修复写回：写入边界的顺序守卫会拒绝覆盖不可读副本
    expect(commandsOf()).toEqual(['load_ai_session', 'load_ai_session_recovery'])
    warn.mockRestore()
  })
})

describe('loadAiSession 副本损坏归类为可安全替换（评审 5161801056/5161978174）', () => {
  it('损坏副本不进新旧未知门禁：展示权威历史、提示将自愈，后续保存正常落盘', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    invoke
      .mockResolvedValueOnce(rec(session('权威', 5)))
      .mockResolvedValueOnce(rec(null, true))
    const store = await import('./aiSessionStore')

    const result = await store.loadAiSession('p1')
    expect(result.session.entries[0].text).toBe('权威')
    expect(result.recoveryUnreadable).toBe(false)
    expect(result.repairError).toContain('损坏')
    warn.mockRestore()
    invoke.mockReset()
    invoke.mockResolvedValue(undefined)

    // 门禁未登记：保存照常发起——写入边界把损坏副本按可替换处理，权威
    // 保存成功后由 Rust 侧清除，无须手工清理磁盘即可自愈
    await store.saveAiSession('p1', session('用户编辑', 6))
    expect(commandsOf()).toEqual(['save_ai_session'])
  })

  it('损坏副本不参与定序：写入序号只从权威文件续起', async () => {
    invoke
      .mockResolvedValueOnce(rec(session('权威', 5)))
      .mockResolvedValueOnce(rec(null, true))
    const store = await import('./aiSessionStore')
    await store.loadAiSession('p1')
    invoke.mockReset()
    invoke.mockResolvedValue(undefined)
    await store.saveAiSession('p1', payload)
    const saved = invoke.mock.calls[0][1] as { session: { writeSeq: number } }
    expect(saved.session.writeSeq).toBe(6)
  })

  it('权威文件损坏不进门禁：按空历史打开、提示自愈，后续保存正常落盘', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    invoke.mockResolvedValueOnce(rec(null, true)).mockResolvedValueOnce(rec(null))
    const store = await import('./aiSessionStore')

    const result = await store.loadAiSession('p1')
    expect(result.session).toEqual({ schemaVersion: 1, entries: [] })
    expect(result.authoritativeUnreadable).toBe(false)
    expect(result.repairError).toContain('权威会话文件损坏')
    warn.mockRestore()
    invoke.mockReset()
    invoke.mockResolvedValue(undefined)

    // 门禁未登记：保存照常发起并按可替换覆盖修复损坏主文件
    await store.saveAiSession('p1', session('用户编辑', 1))
    expect(commandsOf()).toEqual(['save_ai_session'])
  })

  it('权威文件损坏时恢复副本提升失败：如实标记 recovered、失败路径走副本兜底', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    invoke
      .mockResolvedValueOnce(rec(null, true))
      .mockResolvedValueOnce(rec(session('恢复副本', 200)))
      .mockRejectedValueOnce(new Error('磁盘已满'))
      // 冲突检测重读（磁盘最大序号 200 < 本次写入 201 → 真实 I/O 失败）
      .mockResolvedValueOnce(rec(null, true))
      .mockResolvedValueOnce(rec(session('恢复副本', 200)))
      .mockResolvedValueOnce(undefined)
    const store = await import('./aiSessionStore')

    await expect(store.loadAiSession('p1')).resolves.toEqual({
      session: session('恢复副本'),
      repairError: 'Error: 磁盘已满',
      recovered: true,
      recoveryUnreadable: false,
      authoritativeUnreadable: false,
    })
    expect(commandsOf()).toEqual([
      'load_ai_session',
      'load_ai_session_recovery',
      'save_ai_session',
      'load_ai_session',
      'load_ai_session_recovery',
      'stash_ai_session_recovery',
    ])
    warn.mockRestore()
  })
})

describe('saveAiSession Tauri 路径', () => {
  it('保存失败在写链内先尽力写恢复副本再上抛（副本沿用本次写入序号）', async () => {
    invoke.mockResolvedValueOnce(rec(session('权威', 5))).mockResolvedValueOnce(rec(null))
    const { loadAiSession, saveAiSession } = await import('./aiSessionStore')
    await loadAiSession('p1')
    invoke.mockReset()
    invoke
      .mockRejectedValueOnce(new Error('磁盘已满'))
      // 冲突检测重读（磁盘序号 5 仍小于本次写入 6 → 真实 I/O 失败）
      .mockResolvedValueOnce(rec(session('权威', 5)))
      .mockResolvedValueOnce(rec(null))
      .mockResolvedValueOnce(undefined)

    await expect(saveAiSession('p1', payload)).rejects.toThrow('磁盘已满')
    expect(commandsOf()).toEqual([
      'save_ai_session',
      'load_ai_session',
      'load_ai_session_recovery',
      'stash_ai_session_recovery',
    ])
    const saved = invoke.mock.calls[0][1] as { session: { writeSeq: number } }
    const stash = invoke.mock.calls[3][1] as { session: { writeSeq: number } }
    expect(saved.session.writeSeq).toBe(6)
    expect(stash.session.writeSeq).toBe(6)
  })

  it('写入序号单调递增：同毫秒或时钟回拨都不会错序', async () => {
    invoke.mockResolvedValueOnce(rec(session('权威', 5))).mockResolvedValueOnce(rec(null))
    const { loadAiSession, saveAiSession } = await import('./aiSessionStore')
    await loadAiSession('p1')
    invoke.mockReset()
    invoke.mockResolvedValue(undefined)

    await saveAiSession('p1', payload)
    await saveAiSession('p1', payload)
    const seqs = invoke.mock.calls.map(
      (call) => (call[1] as { session: { writeSeq: number } }).session.writeSeq,
    )
    expect(seqs).toEqual([6, 7])
  })

  it('未先 load 的首次保存也从磁盘两副本的最大序号续起', async () => {
    invoke
      .mockResolvedValueOnce(rec(session('权威', 5)))
      .mockResolvedValueOnce(rec(session('副本', 3)))
      .mockResolvedValueOnce(undefined)
    const { saveAiSession } = await import('./aiSessionStore')

    await saveAiSession('p1', payload)
    const saved = invoke.mock.calls[2][1] as { session: { writeSeq: number } }
    expect(saved.session.writeSeq).toBe(6)
  })

  it('恢复副本也写失败时仍上抛原始错误（内存副本保留待重试）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    invoke
      .mockResolvedValueOnce(rec(null))
      .mockResolvedValueOnce(rec(null))
      .mockRejectedValueOnce(new Error('磁盘已满'))
      // 冲突检测重读（序号 0 → 真实失败）
      .mockResolvedValueOnce(rec(null))
      .mockResolvedValueOnce(rec(null))
      .mockRejectedValueOnce(new Error('恢复目录只读'))
    const { saveAiSession } = await import('./aiSessionStore')

    await expect(saveAiSession('p1', payload)).rejects.toThrow('磁盘已满')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

})

describe('saveAiSession Tauri 路径 · 写链内副本', () => {
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

describe('saveAiSession 失败重试与退出冲刷', () => {
  afterEach(() => vi.useRealTimers())

  /** 先 load 播种写入序号，再让一次保存失败（stashOk 决定副本是否成功）。 */
  async function failOnce(store: typeof import('./aiSessionStore'), stashOk = true) {
    invoke.mockResolvedValueOnce(rec(session('权威', 5))).mockResolvedValueOnce(rec(null))
    await store.loadAiSession('p1')
    invoke.mockReset()
    invoke
      .mockRejectedValueOnce(new Error('磁盘已满'))
      // 冲突检测重读（磁盘序号 5 < 本次写入 6 → 真实 I/O 失败）
      .mockResolvedValueOnce(rec(session('权威', 5)))
      .mockResolvedValueOnce(rec(null))
    if (stashOk) invoke.mockResolvedValueOnce(undefined)
    else invoke.mockRejectedValueOnce(new Error('恢复目录只读'))
    await expect(store.saveAiSession('p1', payload)).rejects.toThrow('磁盘已满')
    invoke.mockReset()
  }

  it('副本写入成功即跨进程可恢复：不阻止退出，并按节律重试补写权威文件', async () => {
    vi.useFakeTimers()
    const store = await import('./aiSessionStore')
    await failOnce(store)
    expect(store.hasPendingAiSessionSaves()).toBe(false)

    invoke.mockResolvedValue(undefined)
    await vi.advanceTimersByTimeAsync(5000)
    expect(commandsOf()).toEqual(['save_ai_session'])
  })

  it('两者都失败才阻止退出：冲刷上浮不可恢复 id，存储恢复后清出', async () => {
    vi.useFakeTimers()
    const store = await import('./aiSessionStore')
    await failOnce(store, false)
    expect(store.hasPendingAiSessionSaves()).toBe(true)

    invoke.mockRejectedValue(new Error('磁盘已满'))
    await expect(store.flushPendingAiSessionSaves()).resolves.toEqual({
      unrecoverable: ['p1'],
      orderingBlocked: [],
    })

    invoke.mockReset()
    invoke.mockResolvedValue(undefined)
    await expect(store.flushPendingAiSessionSaves()).resolves.toEqual({
      unrecoverable: [],
      orderingBlocked: [],
    })
    expect(store.hasPendingAiSessionSaves()).toBe(false)
  })

  it('删除项目清出重试登记与不可恢复标记', async () => {
    vi.useFakeTimers()
    const store = await import('./aiSessionStore')
    await failOnce(store, false)
    expect(store.hasPendingAiSessionSaves()).toBe(true)

    store.deleteAiSession('p1')
    expect(store.hasPendingAiSessionSaves()).toBe(false)
    invoke.mockReset()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(commandsOf()).toEqual([])
  })

  it('后台重试补写成功通知订阅者（UI 层据此清错误与保留快照）', async () => {
    vi.useFakeTimers()
    const store = await import('./aiSessionStore')
    await failOnce(store)
    const notified: string[] = []
    const unsubscribe = store.onAiSessionSaved((id) => notified.push(id))

    invoke.mockReset()
    invoke.mockResolvedValue(undefined)
    await vi.advanceTimersByTimeAsync(5000)
    expect(notified).toEqual(['p1'])

    unsubscribe()
    await store.saveAiSession('p1', payload)
    expect(notified).toEqual(['p1'])
  })

})

describe('saveAiSession 新旧未知门禁 · 暂缓与退出屏障', () => {
  it('恢复副本不可读期间：变更保存整次暂缓，不写盘不登记重试；暂缓编辑纳入退出屏障，重开确立定序后恢复保存', async () => {
    const store = await import('./aiSessionStore')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    invoke.mockResolvedValueOnce(rec(session('权威', 5))).mockRejectedValueOnce(new Error('权限拒绝'))
    await store.loadAiSession('p1')
    warn.mockRestore()
    invoke.mockReset()

    // 用户变更：保存必须整次拒绝——主文件可写也不得在副本新旧未知时定序
    // （失败路径的副本改写与重试自增会把序号压过恢复可读的更新副本）
    await expect(store.saveAiSession('p1', session('用户编辑', 6))).rejects.toThrow('暂缓')
    expect(commandsOf()).toEqual([])
    // 暂缓的编辑只存在于内存：退出屏障必须知道它，否则窗口关闭/应用退出
    // 会静默丢弃用户编辑（评审 pullrequestreview-5161801056）；冲刷不得
    // 写盘，只把它作为阻断项上浮
    expect(store.hasPendingAiSessionSaves()).toBe(true)
    await expect(store.flushPendingAiSessionSaves()).resolves.toEqual({
      unrecoverable: [],
      orderingBlocked: ['p1'],
    })

    // 重开（两副本可读）：定序恢复并解除退出阻断，保存以磁盘最大序号续起
    invoke.mockResolvedValueOnce(rec(session('权威', 5))).mockResolvedValueOnce(rec(null))
    await store.loadAiSession('p1')
    expect(store.hasPendingAiSessionSaves()).toBe(false)
    invoke.mockReset()
    invoke.mockResolvedValue(undefined)
    await store.saveAiSession('p1', session('用户编辑', 6))
    const saved = invoke.mock.calls[0][1] as { session: { writeSeq: number } }
    expect(saved.session.writeSeq).toBe(6)
  })

  it('暂缓编辑的退出阻断登记随项目删除清出', async () => {
    const store = await import('./aiSessionStore')
    invoke.mockResolvedValueOnce(rec(session('权威', 5))).mockRejectedValueOnce(new Error('权限拒绝'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await store.loadAiSession('p1')
    warn.mockRestore()
    invoke.mockReset()

    await expect(store.saveAiSession('p1', session('用户编辑', 6))).rejects.toThrow('暂缓')
    expect(store.hasPendingAiSessionSaves()).toBe(true)
    store.deleteAiSession('p1')
    expect(store.hasPendingAiSessionSaves()).toBe(false)
  })

  it('权威文件不可读期间同样暂缓：不写副本、不定序、无重试放大', async () => {
    const store = await import('./aiSessionStore')
    invoke.mockRejectedValueOnce(new Error('权限拒绝')).mockResolvedValueOnce(rec(session('恢复副本', 3)))
    await store.loadAiSession('p1')
    invoke.mockReset()

    await expect(store.saveAiSession('p1', payload)).rejects.toThrow('暂缓')
    expect(commandsOf()).toEqual([])
  })
})

describe('saveAiSession 序号冲突与门禁清出', () => {
  afterEach(() => vi.useRealTimers())

  it('序号陈旧冲突（他进程已写更新历史）不写副本不登记重试：上浮重载提示', async () => {
    vi.useFakeTimers()
    const store = await import('./aiSessionStore')
    invoke.mockResolvedValueOnce(rec(session('权威', 5))).mockResolvedValueOnce(rec(null))
    await store.loadAiSession('p1')
    invoke.mockReset()
    // 主保存被顺序守卫拒绝；重读发现磁盘序号（9）已不小于本次写入（6）
    invoke
      .mockRejectedValueOnce(
        new Error('AI 会话文件比本次保存更新，已拒绝覆盖（请重新打开项目载入更新的历史）'),
      )
      .mockResolvedValueOnce(rec(session('他进程权威', 9)))
      .mockResolvedValueOnce(rec(null))

    await expect(store.saveAiSession('p1', payload)).rejects.toThrow('更新')
    expect(commandsOf()).toEqual([
      'save_ai_session',
      'load_ai_session',
      'load_ai_session_recovery',
    ])
    // 冲突快照不得进入重试循环：重试逐次自增序号终将压过磁盘序号、以旧
    // 历史覆盖新会话，绕过顺序守卫
    expect(store.hasPendingAiSessionSaves()).toBe(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(invoke).toHaveBeenCalledTimes(3)
  })

  it('两副本都不可读（载入上浮）同样登记门禁；删除项目清出', async () => {
    const store = await import('./aiSessionStore')
    invoke.mockRejectedValueOnce(new Error('权限拒绝')).mockRejectedValueOnce(new Error('权限拒绝'))
    await expect(store.loadAiSession('p1')).rejects.toThrow('权限拒绝')
    invoke.mockReset()

    await expect(store.saveAiSession('p1', payload)).rejects.toThrow('暂缓')
    expect(commandsOf()).toEqual([])
    store.deleteAiSession('p1')
    invoke.mockResolvedValue(undefined)
    await store.saveAiSession('p1', payload)
    expect(commandsOf()).toEqual(['save_ai_session'])
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
    // 播种序号与 IPC 发起需数个节拍
    await vi.waitFor(() => { expect(typeof release).toBe('function') })
    const flushing = store.flushPendingAiSessionSaves()
    release()
    await saving
    await expect(flushing).resolves.toEqual({ unrecoverable: [], orderingBlocked: [] })
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
    await expect(flushing).resolves.toEqual({ unrecoverable: [], orderingBlocked: [] })
    expect(store.hasPendingAiSessionSaves()).toBe(false)
  })
})

describe('saveAiSession 在途保存与定时器代次', () => {
  afterEach(() => vi.useRealTimers())

  it('乱序返回的并发载入不得回拨写入序号', async () => {
    const store = await import('./aiSessionStore')
    const releaseRef: { current: (() => void) | null } = { current: null }
    invoke.mockImplementation((cmd: unknown) => {
      if (cmd === 'load_ai_session') {
        // 第一次载入挂起（旧快照 seq 5），第二次立即返回（seq 5）
        if (releaseRef.current === null) {
          return new Promise((resolve) => {
            releaseRef.current = () => resolve(rec(session('权威', 5)))
          })
        }
        return Promise.resolve(rec(session('权威', 5)))
      }
      if (cmd === 'load_ai_session_recovery') return Promise.resolve(rec(null))
      return Promise.resolve(undefined)
    })

    const older = store.loadAiSession('p1')
    // 被测竞态是 IPC 乱序完成（首读挂起、后发载入先完成）；模块导入本身
    // 顺序等待（测试环境的模块 mock 不覆盖并发动态导入）
    await vi.waitFor(() => { expect(invoke).toHaveBeenCalledTimes(1) })
    await store.loadAiSession('p1')
    invoke.mockReset()
    invoke.mockResolvedValue(undefined)
    await store.saveAiSession('p1', payload)
    releaseRef.current?.()
    await older
    // 旧载入带着 seq 5 快照迟到：不得把内存序号拨回 5——回拨后的下一次
    // 保存与权威文件同号，主保存失败时副本以相同序号落盘，重开时副本
    // 不严格大于主文件而被忽略，新历史丢失
    await store.saveAiSession('p1', payload)
    const seqs = invoke.mock.calls
      .filter((call) => call[0] === 'save_ai_session')
      .map((call) => (call[1] as { session: { writeSeq: number } }).session.writeSeq)
    expect(seqs).toEqual([6, 7])
  })

  it('新代次失败替换旧定时器：重试的是最新会话', async () => {
    vi.useFakeTimers()
    invoke.mockResolvedValueOnce(rec(session('权威', 5))).mockResolvedValueOnce(rec(null))
    const store = await import('./aiSessionStore')
    await store.loadAiSession('p1')
    invoke.mockReset()
    // 每次失败：save 拒绝 → 冲突重读 ×2（序号 5 → 真实失败）→ 副本拒绝
    invoke
      .mockRejectedValueOnce(new Error('磁盘已满'))
      .mockResolvedValueOnce(rec(session('权威', 5)))
      .mockResolvedValueOnce(rec(null))
      .mockRejectedValueOnce(new Error('恢复目录只读'))
    await expect(store.saveAiSession('p1', session('旧会话', 6))).rejects.toThrow('磁盘已满')
    invoke.mockReset()
    invoke
      .mockRejectedValueOnce(new Error('磁盘已满'))
      .mockResolvedValueOnce(rec(session('权威', 5)))
      .mockResolvedValueOnce(rec(null))
      .mockRejectedValueOnce(new Error('恢复目录只读'))
    await expect(store.saveAiSession('p1', session('新会话', 7))).rejects.toThrow('磁盘已满')

    invoke.mockReset()
    invoke.mockResolvedValue(undefined)
    await vi.advanceTimersByTimeAsync(5000)
    const retried = invoke.mock.calls[0][1] as { session: { entries: { text: string }[] } }
    expect(retried.session.entries[0].text).toBe('新会话')
  })
})
