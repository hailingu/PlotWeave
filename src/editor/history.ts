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
 * 撤销/重做栈 hook。canUndo/canRedo 随 version 重算；
 * 命令执行（undo/redo 内的 setState）驱动画布重渲染。
 */
export function useCommandHistory() {
  const stacks = useRef<{ undo: HistoryCommand[]; redo: HistoryCommand[] }>({
    undo: [],
    redo: [],
  })
  const [version, setVersion] = useState(0)
  const bump = useCallback(() => setVersion((v) => v + 1), [])

  /** 入栈并清空重做分支；窗口内的同类补丁合并为一步。 */
  const push = useCallback(
    (cmd: HistoryCommand) => {
      const { undo: undoStack } = stacks.current
      const top = undoStack[undoStack.length - 1]
      const mergeable =
        cmd.coalesceKey !== undefined &&
        top?.coalesceKey === cmd.coalesceKey &&
        Date.now() - (top.timestamp ?? 0) < COALESCE_MS
      if (mergeable) {
        top.redo = cmd.redo
        top.timestamp = Date.now()
      } else {
        undoStack.push({ ...cmd, timestamp: Date.now() })
        if (undoStack.length > STACK_LIMIT) undoStack.shift()
      }
      stacks.current.redo = []
      bump()
    },
    [bump],
  )

  const undo = useCallback(() => {
    const cmd = stacks.current.undo.pop()
    if (!cmd) return
    cmd.undo()
    stacks.current.redo.push(cmd)
    bump()
  }, [bump])

  const redo = useCallback(() => {
    const cmd = stacks.current.redo.pop()
    if (!cmd) return
    cmd.redo()
    stacks.current.undo.push(cmd)
    bump()
  }, [bump])

  const clear = useCallback(() => {
    stacks.current.undo = []
    stacks.current.redo = []
    bump()
  }, [bump])

  return {
    push,
    undo,
    redo,
    clear,
    canUndo: stacks.current.undo.length > 0,
    canRedo: stacks.current.redo.length > 0,
    version,
  }
}
