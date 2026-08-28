import { useCallback, useRef, useState } from 'react'

/**
 * 命令栈：撤销 / 重做（docs/ui-design.md §3.3 左区、§4.3、数据模型 §11–§12）。
 * 画布全部写操作建模为命令入栈——undo 始终兜底；后续 AI 改动预览卡
 * （batch 命令，整批一步撤销）复用同一栈。
 *
 * 合并策略：连续对同一节点同一组字段的补丁（如逐字符输入）在
 * COALESCE_MS 内合并为一步撤销，避免每键一次。
 */

/** 一次可撤销的写操作。undo/redo 闭包由调用方捕获 setState 构成。 */
export interface HistoryCommand {
  /** 调试与合并标识；patch 命令填 `patch:<id>:<keys>` 形式。 */
  coalesceKey?: string
  undo: () => void
  redo: () => void
  /** 入栈时间戳，补丁合并窗口判断用。 */
  timestamp?: number
}

/** 补丁合并窗口（毫秒）。 */
const COALESCE_MS = 800
/** 栈深上限，防长会话内存膨胀。 */
const STACK_LIMIT = 200

/**
 * 纯命令栈（useCommandHistory 的可测核心）：栈操作与合并窗口不依赖
 * React，时钟/上限可注入；每次状态变化经 onChange 通知宿主重渲染。
 */
export class CommandStack {
  private undoStack: HistoryCommand[] = []
  private redoStack: HistoryCommand[] = []

  constructor(
    private readonly coalesceMs: number = COALESCE_MS,
    private readonly limit: number = STACK_LIMIT,
    private readonly now: () => number = Date.now,
    private readonly onChange?: () => void,
  ) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  /** 入栈并清空重做分支；窗口内的同类补丁合并为一步（redo 换新，undo 保留首条）。 */
  push(cmd: HistoryCommand): void {
    const top = this.undoStack[this.undoStack.length - 1]
    const mergeable =
      cmd.coalesceKey !== undefined &&
      top?.coalesceKey === cmd.coalesceKey &&
      this.now() - (top.timestamp ?? 0) < this.coalesceMs
    if (mergeable) {
      top.redo = cmd.redo
      top.timestamp = this.now()
    } else {
      this.undoStack.push({ ...cmd, timestamp: this.now() })
      if (this.undoStack.length > this.limit) this.undoStack.shift()
    }
    this.redoStack = []
    this.onChange?.()
  }

  undo(): void {
    const cmd = this.undoStack.pop()
    if (!cmd) return
    cmd.undo()
    this.redoStack.push(cmd)
    this.onChange?.()
  }

  redo(): void {
    const cmd = this.redoStack.pop()
    if (!cmd) return
    cmd.redo()
    this.undoStack.push(cmd)
    this.onChange?.()
  }

  clear(): void {
    this.undoStack = []
    this.redoStack = []
    this.onChange?.()
  }
}

/**
 * 撤销/重做栈 hook。canUndo/canRedo 随 version 重算；
 * 命令执行（undo/redo 内的 setState）驱动画布重渲染。
 */
export function useCommandHistory() {
  const [version, setVersion] = useState(0)
  const stackRef = useRef<CommandStack | null>(null)
  // 惰性构建：setVersion 只在变更回调里触发，构造期不产生渲染副作用
  stackRef.current ??= new CommandStack(
    COALESCE_MS,
    STACK_LIMIT,
    Date.now,
    () => setVersion((v) => v + 1),
  )
  const stack = stackRef.current

  return {
    push: useCallback((cmd: HistoryCommand) => stack.push(cmd), [stack]),
    undo: useCallback(() => stack.undo(), [stack]),
    redo: useCallback(() => stack.redo(), [stack]),
    clear: useCallback(() => stack.clear(), [stack]),
    canUndo: stack.canUndo,
    canRedo: stack.canRedo,
    version,
  }
}
