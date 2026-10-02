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
  /** 重做前的异步复验（issue #10）：只读不改状态——校验通过后才执行
   * redo 应用。资产重回索引的命令（库导入/生成产物）挂载它复验文件
   * 落盘状态，撤销窗口内被外部删改则拒绝重做入脏；拒绝时本次重做
   * 放弃、命令留在重做栈（外部条件恢复后可重试）。 */
  redoGuard?: () => Promise<void>
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
  /** 栈操作版本号：push、撤销请求（含空栈撤销——撤销意向即操作）、
   * 带 guard 的重做**发起**（重复请求时只有最新一次在途校验有效）、
   * redo 应用与 clear 递增。带 redoGuard 的在途重做以「校验前后版本
   * 未变」为应用前提——任何穿插操作（含撤销-重做往返使栈顶 identity
   * 恰好复原的 ABA 场景、空栈撤销请求、对同一命令的重复重做发起）
   * 都使本次重做失效；单比栈顶 identity 防不住这些场景。 */
  private revision = 0

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
    this.revision += 1
    this.onChange?.()
  }

  undo(): void {
    const cmd = this.undoStack.pop()
    if (cmd === undefined) {
      // 空栈撤销仍是用户操作请求：按「最新操作优先」取消在途重做
      //（无栈变更，不触发 onChange）
      this.revision += 1
      return
    }
    cmd.undo()
    this.redoStack.push(cmd)
    this.revision += 1
    this.onChange?.()
  }

  /**
   * 重做栈顶命令。无 redoGuard 的命令走同步快路径（返回 undefined，
   * 与既有契约逐字一致）；带 redoGuard 的命令先等待校验：拒绝则本次
   * 重做放弃、命令留在重做栈、拒绝原因经返回的 Promise 传播；校验
   * 在途期间发生**任何**栈变更（并发撤销/重做/新编辑——含撤销-重做
   * 往返使栈顶 identity 恰好复原、空栈撤销请求）则静默放弃：最新
   * 操作优先，绝不应用穿插操作之前的在途重做。**履约与拒绝两侧都以
   * 版本未变为前提**——已被取代的重做连迟到拒绝也不传播（操作已
   * 静默放弃，迟到的失败横幅只会覆盖更新的动作诊断）。校验只读不改
   * 状态，应用本身保持同步原子。
   */
  redo(): void | Promise<void> {
    const cmd = this.redoStack[this.redoStack.length - 1]
    if (!cmd) return
    const guard = cmd.redoGuard
    if (guard === undefined) {
      this.applyRedo(cmd)
      return
    }
    // 发起即计一次操作（无栈变更，不触发 onChange）：使更早的在途重做
    // 全部失效——重复请求同一 guarded 命令时，迟到的旧履约不得越过
    // 最新校验的结论（新校验拒绝后旧履约仍应用 = 失效资产入文档）
    this.revision += 1
    const revision = this.revision
    return guard().then(
      () => {
        if (this.revision !== revision) return
        this.applyRedo(cmd)
      },
      (err: unknown) => {
        if (this.revision !== revision) return
        throw err
      },
    )
  }

  /** 弹出并应用重做命令、移入撤销栈（redo 快慢路径共用的原子收尾）。 */
  private applyRedo(cmd: HistoryCommand): void {
    this.redoStack.pop()
    cmd.redo()
    this.undoStack.push(cmd)
    this.revision += 1
    this.onChange?.()
  }

  clear(): void {
    this.undoStack = []
    this.redoStack = []
    this.revision += 1
    this.onChange?.()
  }
}

/**
 * 撤销/重做栈 hook。canUndo/canRedo 随 version 重算；命令执行
 * （undo/onRedo 内的 setState）驱动画布重渲染。
 *
 * onRedo 带诊断（issue #10）：带 redoGuard 的重做拒绝时经 onRedoError
 * 上浮横幅文案；无 guard 命令是同步路径（无 Promise），不触横幅。
 * 出口回调必填——拒绝原因不得被静默吞掉。完成（含成功应用与被取代
 * 放弃）**不回投清除**：横幅槽与其他动作错误共享，慢校验的旧重做
 * 完成时无法判定槽内是否仍是自己写的文案，清除会吞掉更新的其他
 * 动作错误；与既有瞬态横幅（拖放/保存失败）一致，由后续诊断替换。
 */
export function useCommandHistory(onRedoError: (message: string) => void) {
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

  /** 重做入口：先走栈（可能因 redoGuard 拒绝放弃），拒绝回投横幅槽。 */
  const onRedo = useCallback(() => {
    const pending = stack.redo()
    if (pending === undefined) return
    pending.catch((err: unknown) => {
      onRedoError(
        `重做失败：${err instanceof Error ? err.message : String(err)}（资产文件可能已被外部删改，可恢复后重试）`,
      )
    })
  }, [stack, onRedoError])

  return {
    push: useCallback((cmd: HistoryCommand) => stack.push(cmd), [stack]),
    undo: useCallback(() => stack.undo(), [stack]),
    onRedo,
    clear: useCallback(() => stack.clear(), [stack]),
    canUndo: stack.canUndo,
    canRedo: stack.canRedo,
    version,
  }
}
