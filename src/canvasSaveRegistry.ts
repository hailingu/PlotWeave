/**
 * 画布退出冲刷注册表（issue #119）：编辑器防抖保存的脏文档是组件内 refs，
 * App 级退出屏障（useExitFlush）不可见——屏障只看本表，不静态引入编辑器
 * 域（编辑器随 React Flow 惰性分块，入口 chunk 不得被拖入，issue #34）。
 * 编辑器挂载期间在此登记「待冲刷」探针与立即冲刷动作，卸载注销。
 * 单应用同一时刻至多一个编辑器实例（单写者模型）：后登记取代先登记。
 * 本模块只做登记转发，不持有任何文档内容。
 */

/** 画布冲刷闸：由防抖落盘 hook（useDebouncedSave）提供实现。 */
export interface CanvasFlushGate {
  /** 仍有未落盘编辑（脏文档或在途保存）。 */
  hasPending: () => boolean
  /** 立即冲刷：等在途落定并补交脏文档；失败保留脏态由防抖节律重试，
   * 不在闸内紧循环（退出屏障据 hasPending 阻断并提示）。 */
  flush: () => Promise<void>
}

let gate: CanvasFlushGate | null = null

/** 登记/注销（传 null）画布冲刷闸。 */
export function registerCanvasFlushGate(next: CanvasFlushGate | null): void {
  gate = next
}

/** 有未落盘画布编辑（无登记闸时为假：编辑器未挂载即无防抖脏文档）。 */
export function hasPendingCanvasSaves(): boolean {
  return gate?.hasPending() ?? false
}

/** 立即冲刷画布脏文档；无登记闸时为无操作。 */
export async function flushPendingCanvasSaves(): Promise<void> {
  await gate?.flush()
}
