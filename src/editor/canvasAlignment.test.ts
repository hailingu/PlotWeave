/** 几何边界：真实尺寸优先、选中范围、输入不变性与非法尺寸的整批拒绝。 */
import { describe, expect, it } from 'vitest'
import { computeCanvasAlignment } from './canvasAlignment'
import type { CanvasNode } from './nodes/types'

/** 小尺寸节点便于手算；测量值与落盘值故意不同以检测优先级。 */
function nodes(): CanvasNode[] {
  return [
    {
      id: 'a',
      type: 'beat',
      selected: true,
      position: { x: -20, y: 10 },
      width: 100,
      height: 80,
      measured: { width: 120, height: 90 },
      data: { name: '开场', tone: '' },
    },
    {
      id: 'b',
      type: 'beat',
      selected: true,
      position: { x: 180, y: 210 },
      width: 60,
      height: 40,
      data: { name: '转折', tone: '' },
    },
  ]
}

describe('computeCanvasAlignment', () => {
  it('尺寸先用实测、无实测再用落盘尺寸，计算不改输入节点', () => {
    const initial = nodes()
    const before = structuredClone(initial)
    expect([...computeCanvasAlignment(initial, 'right')]).toEqual([
      ['a', { x: 120, y: 10 }],
    ])
    expect([...computeCanvasAlignment(initial, 'bottom')]).toEqual([
      ['a', { x: -20, y: 160 }],
    ])
    expect(initial).toEqual(before)
  })

  it('无效实测值不覆盖已有可用的落盘尺寸', () => {
    const initial = nodes()
    initial[0]!.measured = { width: 0, height: Number.NaN }
    expect([...computeCanvasAlignment(initial, 'right')]).toEqual([
      ['a', { x: 140, y: 10 }],
    ])
  })

  it('少于两个选中节点时无操作，不因未选中节点未测量而拒绝', () => {
    const initial = nodes()
    initial[0]!.selected = false
    delete initial[0]!.measured
    delete initial[0]!.width
    expect(computeCanvasAlignment(initial, 'right').size).toBe(0)
    expect(computeCanvasAlignment([], 'left').size).toBe(0)
  })

  it('选中尺寸缺失与坐标溢出都不产生部分对齐结果', () => {
    const initial = nodes()
    delete initial[1]!.height
    expect(() => computeCanvasAlignment(initial, 'left')).toThrow('尺寸测量')
    initial[1]!.height = 40
    initial[1]!.position.x = Number.POSITIVE_INFINITY
    expect(() => computeCanvasAlignment(initial, 'right')).toThrow('位置')
    expect(initial[0]!.position).toEqual({ x: -20, y: 10 })
  })
})
