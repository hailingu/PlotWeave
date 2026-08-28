import { describe, expect, it, vi } from 'vitest'
import { CommandStack, type HistoryCommand } from './history'

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
