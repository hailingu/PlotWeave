/**
 * 画布区域渲染边界契约（issue #103）：默认导出必须是 memo 隔离边界——
 * 布局层下传的画布输入引用稳定时，面板状态变化跳过整个区域子树的执行。
 * 探针集成测试（renderIsolation）度量组合行为；本文件锁定真实模块自身
 * 不得回退为未包裹的裸组件（mock 探针看不到真实导出）。
 */
import { describe, expect, it } from 'vitest'
import { EditorCanvasRegion } from './EditorCanvasRegion'

describe('EditorCanvasRegion 渲染边界', () => {
  it('默认导出是 memo 包裹的隔离边界', () => {
    const memoType = Symbol.for('react.memo')
    expect(
      (EditorCanvasRegion as unknown as { $$typeof?: symbol }).$$typeof,
    ).toBe(memoType)
  })
})
