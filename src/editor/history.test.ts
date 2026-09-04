// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { CommandStack, useCommandHistory, type HistoryCommand } from './history'

/** 可注入时钟的命令栈：t 递增受控推进。 */
function stack(opts?: { coalesceMs?: number; limit?: number }) {
  let t = 1_000
  const clock = vi.fn((): number => t)
  const s = new CommandStack(opts?.coalesceMs ?? 800, opts?.limit ?? 200, clock)
  return {
    s,
    clock,
    advance: (ms: number) => {
      t += ms
    },
  }
}

const cmd = (key: string | undefined, tag = key ?? 'x'): HistoryCommand => ({
  coalesceKey: key,
  undo: vi.fn(),
  redo: vi.fn(),
  ...(tag ? {} : {}),
})

describe('CommandStack：撤销/重做基本语义', () => {
  it('push 后可 undo 再 redo；undo/redo 闭包按入栈顺序执行', () => {
    const { s } = stack()
    const a = cmd('a')
    const b = cmd('b')
    s.push(a)
    s.push(b)
    expect(s.canUndo).toBe(true)
    expect(s.canRedo).toBe(false)

    s.undo()
    expect(b.undo).toHaveBeenCalledTimes(1)
    expect(a.undo).not.toHaveBeenCalled()
    expect(s.canRedo).toBe(true)

    s.redo()
    expect(b.redo).toHaveBeenCalledTimes(1)
  })

  it('空栈 undo/redo 是无操作（不抛错、不触发 onChange）', () => {
    const onChange = vi.fn()
    const s = new CommandStack(800, 200, () => 0, onChange)
    s.undo()
    s.redo()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('新 push 清空重做分支（分叉丢弃）', () => {
    const { s } = stack()
    s.push(cmd('a'))
    s.undo()
    expect(s.canRedo).toBe(true)
    s.push(cmd('b'))
    expect(s.canRedo).toBe(false)
  })

  it('clear 清双栈', () => {
    const { s } = stack()
    s.push(cmd('a'))
    s.undo()
    s.clear()
    expect(s.canUndo).toBe(false)
    expect(s.canRedo).toBe(false)
  })
})

describe('CommandStack：补丁合并窗口（逐字符输入 = 一步撤销）', () => {
  it('窗口内同 key 合并：只保留一步，undo 执行首条、redo 执行末条', () => {
    const { s, advance } = stack()
    const first = cmd('patch:n1:name')
    const second = cmd('patch:n1:name')
    first.undo = vi.fn()
    second.redo = vi.fn()
    s.push(first)
    advance(100)
    s.push(second)

    // 合并后只算一步：一次 undo 清空 undo 栈
    s.undo()
    expect(s.canUndo).toBe(false)
    expect(first.undo).toHaveBeenCalledTimes(1)
    expect(second.undo).not.toHaveBeenCalled()

    // 重做执行末条的 redo（首条的 redo 被替换）
    s.redo()
    expect(second.redo).toHaveBeenCalledTimes(1)
  })

  it('窗口过期后同 key 不再合并；不同 key 不合并', () => {
    const { s, advance } = stack()
    s.push(cmd('patch:n1:name'))
    advance(801)
    s.push(cmd('patch:n1:name'))
    s.undo()
    expect(s.canUndo).toBe(true) // 第二条弹出后仍剩第一条

    const { s: s2, advance: advance2 } = stack()
    s2.push(cmd('patch:n1:name'))
    advance2(10)
    s2.push(cmd('patch:n1:synopsis'))
    s2.undo()
    expect(s2.canUndo).toBe(true)
  })

  it('合并会刷新时间戳：连续输入跨窗口也保持一步（打字间歇 < 窗口即可）', () => {
    const { s, advance } = stack() // 800ms 窗口
    s.push(cmd('k'))
    advance(700)
    s.push(cmd('k')) // 合并，timestamp 刷新
    advance(700) // 距上次合并 700 < 800
    s.push(cmd('k')) // 仍合并
    s.undo()
    expect(s.canUndo).toBe(false) // 三条并作一步
  })

  it('coalesceKey 缺失的命令永不合并', () => {
    const { s, advance } = stack()
    s.push(cmd(undefined))
    advance(1)
    s.push(cmd(undefined))
    s.undo()
    expect(s.canUndo).toBe(true)
  })
})

describe('CommandStack：栈深上限', () => {
  it('超过 limit 后丢弃最旧命令（shift），最新 200 条仍可撤销', () => {
    const { s } = stack({ limit: 3 })
    const oldest = cmd('a')
    const oldestUndo = vi.fn()
    oldest.undo = oldestUndo
    s.push(oldest)
    s.push(cmd('b'))
    s.push(cmd('c'))
    s.push(cmd('d')) // 挤掉 a
    s.undo()
    s.undo()
    s.undo()
    s.undo() // a 已不在栈中
    expect(oldestUndo).not.toHaveBeenCalled()
    expect(s.canUndo).toBe(false)
  })
})

describe('CommandStack：redoGuard（资产重回索引前的异步复验，issue #10）', () => {
  it('无 redoGuard 的命令保持同步语义：redo() 返回 undefined 且立即应用', () => {
    const { s } = stack()
    const c = cmd(undefined)
    s.push(c)
    s.undo()
    const ret = s.redo()
    expect(ret).toBeUndefined()
    expect(c.redo).toHaveBeenCalledTimes(1)
  })

  it('带 redoGuard 的命令：校验通过后应用，返回 Promise', async () => {
    const { s } = stack()
    const guard = vi.fn(() => Promise.resolve())
    const c: HistoryCommand = { undo: vi.fn(), redo: vi.fn(), redoGuard: guard }
    s.push(c)
    s.undo()
    await s.redo()
    expect(guard).toHaveBeenCalledTimes(1)
    expect(c.redo).toHaveBeenCalledTimes(1)
    expect(s.canUndo).toBe(true)
  })

  it('校验拒绝：本次重做放弃、不应用、命令留在重做栈可重试，拒绝原因传播', async () => {
    const { s } = stack()
    const c: HistoryCommand = {
      undo: vi.fn(),
      redo: vi.fn(),
      redoGuard: () => Promise.reject(new Error('资产文件已失效')),
    }
    s.push(c)
    s.undo()
    await expect(s.redo()).rejects.toThrow('资产文件已失效')
    expect(c.redo).not.toHaveBeenCalled()
    expect(s.canRedo).toBe(true)
    expect(s.canUndo).toBe(false)
  })

  it('校验在途期间栈顶被新编辑取代：静默放弃，不应用被取代的命令', async () => {
    const { s } = stack()
    let release: () => void = () => {}
    const c: HistoryCommand = {
      undo: vi.fn(),
      redo: vi.fn(),
      redoGuard: () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    }
    s.push(c)
    s.undo()
    const pending = s.redo()
    s.push(cmd('new')) // 校验在途时新编辑清空重做分支：c 已被取代
    release()
    await pending
    expect(c.redo).not.toHaveBeenCalled()
    expect(s.canRedo).toBe(false)
  })

  it('校验在途期间撤销-重做往返（栈顶 identity 复原）：仍视为被取代，静默放弃', async () => {
    const { s } = stack()
    let release: () => void = () => {}
    const guarded: HistoryCommand = {
      undo: vi.fn(),
      redo: vi.fn(),
      redoGuard: () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    }
    const older = cmd('older')
    s.push(older)
    s.push(guarded)
    s.undo() // guarded → 重做栈；older 仍可撤销
    const pending = s.redo() // guarded 校验在途
    s.undo() // older 上到重做栈顶，取代 guarded
    s.redo() // older 同步重做回撤销栈——栈顶 identity 复原为 guarded
    release()
    await pending
    expect(guarded.redo).not.toHaveBeenCalled()
    expect(s.canRedo).toBe(true) // guarded 留在重做栈：可再次显式重做
    expect(older.redo).toHaveBeenCalledTimes(1)
  })
})

describe('useCommandHistory（命令栈 hook：惰性构建 + version 驱动重渲染）', () => {
  /** 横幅槽替身：捕获 onRedoError 收到的文案（null = 清除）。 */
  const sink = () => vi.fn<(message: string | null) => void>()

  it('push/undo/onRedo/clear 委托栈实现；canUndo/canRedo 随 version 重算', () => {
    const { result } = renderHook(() => useCommandHistory(sink()))
    expect(result.current.canUndo).toBe(false)
    expect(result.current.canRedo).toBe(false)
    const v0 = result.current.version

    const c: HistoryCommand = { undo: vi.fn(), redo: vi.fn() }
    act(() => result.current.push(c))
    expect(result.current.canUndo).toBe(true)
    expect(result.current.version).toBeGreaterThan(v0)

    act(() => result.current.undo())
    expect(c.undo).toHaveBeenCalledTimes(1)
    expect(result.current.canUndo).toBe(false)
    expect(result.current.canRedo).toBe(true)

    act(() => result.current.onRedo())
    expect(c.redo).toHaveBeenCalledTimes(1)
    expect(result.current.canUndo).toBe(true)

    act(() => result.current.clear())
    expect(result.current.canUndo).toBe(false)
    expect(result.current.canRedo).toBe(false)
  })

  it('重渲染复用同一栈实例（回调引用稳定）', () => {
    const onRedoError = sink()
    const { result, rerender } = renderHook(() => useCommandHistory(onRedoError))
    const pushRef = result.current.push
    act(() => result.current.push(cmd('k')))
    rerender()
    expect(result.current.push).toBe(pushRef)
    expect(result.current.canUndo).toBe(true) // 栈未随重渲染重建
  })

  it('onRedo 诊断（issue #10）：同步路径不触横幅；拒绝上浮文案；成功清除', async () => {
    const onRedoError = sink()
    const { result } = renderHook(() => useCommandHistory(onRedoError))

    const sync: HistoryCommand = { undo: vi.fn(), redo: vi.fn() }
    act(() => result.current.push(sync))
    act(() => result.current.undo())
    act(() => result.current.onRedo()) // 无 guard：同步应用，无横幅回调
    expect(sync.redo).toHaveBeenCalledTimes(1)
    expect(onRedoError).not.toHaveBeenCalled()

    const guardMock = vi.fn((): Promise<void> => Promise.reject(new Error('资产文件已失效')))
    const guarded: HistoryCommand = { undo: vi.fn(), redo: vi.fn(), redoGuard: guardMock }
    act(() => result.current.push(guarded))
    act(() => result.current.undo())
    act(() => result.current.onRedo())
    await waitFor(() => expect(onRedoError).toHaveBeenCalledWith(expect.stringContaining('资产文件已失效')))
    expect(onRedoError).toHaveBeenLastCalledWith(expect.stringContaining('重做失败'))
    expect(guarded.redo).not.toHaveBeenCalled()

    onRedoError.mockClear()
    guardMock.mockResolvedValue(undefined)
    act(() => result.current.onRedo())
    await waitFor(() => expect(guarded.redo).toHaveBeenCalledTimes(1))
    expect(onRedoError).toHaveBeenCalledWith(null)
  })
})
