// @vitest-environment happy-dom
/** 确定时钟验证统计、资源生命周期、能力降级和跨段隔离，不依赖真实帧率。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createCanvasPerformanceRecorder,
  type CanvasPerformanceReport,
} from './canvasPerformance'

let time = 0
let nextFrame = 0
let frames: Map<number, FrameRequestCallback>

beforeEach(() => {
  time = 0
  nextFrame = 0
  frames = new Map()
  vi.spyOn(performance, 'now').mockImplementation(() => time)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.stubGlobal('PerformanceObserver', undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  performance.clearMeasures('plotweave.canvas.node-drag.editor')
})

/** rAF 由外部浏览器驱动，推进真实 recorder 而非伪造统计结果。 */
function frame(at: number) {
  time = at
  const pending = [...frames.values()]
  frames.clear()
  pending.forEach((callback) => callback(at))
}

/** 发布边界只收集最终报告，便于断言诊断消费者真正看到的数字。 */
function setup() {
  const reports: CanvasPerformanceReport[] = []
  const recorder = createCanvasPerformanceRecorder('editor', (report) =>
    reports.push(report),
  )
  return { recorder, reports }
}

describe('拖动性能采样器', () => {
  it('绘制模式在段开始捕获，后续段恢复标准且不改写旧报告', () => {
    const { recorder, reports } = setup()
    recorder.start(
      { nodeCount: 1, edgeCount: 0, draggedNodeCount: 1 },
      'reduced-effects',
    )
    recorder.finish('interrupted')
    recorder.start({ nodeCount: 1, edgeCount: 0, draggedNodeCount: 1 })
    recorder.finish('completed')
    expect(reports.map((report) => report.renderingMode)).toEqual([
      'reduced-effects',
      'standard',
    ])
    expect(reports[0]?.version).toBe(5)
    recorder.dispose()
  })

  it('编辑器整体与画布嵌套统计分别记录，段外回调与下一段不串样本', () => {
    const { recorder, reports } = setup()
    recorder.render(100, 200, 'editor')
    recorder.start({ nodeCount: 1, edgeCount: 0, draggedNodeCount: 1 })
    recorder.render(2, 4)
    recorder.render(10, 20, 'editor')
    recorder.render(3, 6)
    recorder.render(15, 30, 'editor')
    expect(reports).toEqual([])
    recorder.finish('completed')
    expect(reports[0]).toMatchObject({
      version: 5,
      react: { samples: 2, totalMs: 5, maxMs: 3, maxBaseMs: 6 },
      reactEditor: { samples: 2, totalMs: 25, maxMs: 15, maxBaseMs: 30 },
    })
    recorder.render(100, 200, 'editor')
    recorder.start({ nodeCount: 1, edgeCount: 0, draggedNodeCount: 1 })
    recorder.finish('completed')
    expect(reports[1]).toMatchObject({ react: null, reactEditor: null })
    recorder.dispose()
  })

  it('聚合同步处理、帧间隔和 React 数据，松手前不发布', () => {
    const { recorder, reports } = setup()
    recorder.start({ nodeCount: 12, edgeCount: 7, draggedNodeCount: 2 })
    recorder.measureChanges(
      [
        {
          id: 'secret',
          type: 'position',
          position: { x: 15, y: 19 },
          dragging: true,
        },
        { id: 'secret', type: 'select', selected: true },
      ],
      () => {
        time = 4
      },
    )
    recorder.render(6, 10)
    frame(16)
    recorder.measureChanges(
      [
        {
          id: 'secret',
          type: 'dimensions',
          dimensions: { width: 100, height: 80 },
        },
      ],
      () => {
        time = 18
      },
    )
    recorder.render(2, 9)
    frame(64)
    expect(reports).toEqual([])
    time = 80
    recorder.finish('completed')
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({
      nodeCount: 12,
      edgeCount: 7,
      draggedNodeCount: 2,
      durationMs: 80,
      changes: { position: 1, select: 1, dimensions: 1 },
      handler: { samples: 2, totalMs: 6, maxMs: 4 },
      frames: { samples: 2, totalMs: 64, maxMs: 48, over32Ms: 1 },
      react: { samples: 2, totalMs: 8, maxMs: 6, maxBaseMs: 10 },
      longTasks: null,
    })
    expect(JSON.stringify(reports)).not.toContain('secret')
    expect(frames.size).toBe(0)
    expect(
      performance.getEntriesByName('plotweave.canvas.node-drag.editor'),
    ).toHaveLength(1)
    recorder.dispose()
    expect(
      performance.getEntriesByName('plotweave.canvas.node-drag.editor'),
    ).toEqual([])
  })

  it('下一段清空统计，重复 stop 和未开始的回调不重复报告', () => {
    const { recorder, reports } = setup()
    recorder.measureChanges([], () => {
      time = 5
    })
    recorder.render(9, 10)
    recorder.finish('completed')
    expect(reports).toEqual([])
    recorder.start({ nodeCount: 1, edgeCount: 0, draggedNodeCount: 1 })
    frame(21)
    recorder.finish('completed')
    recorder.finish('completed')
    recorder.start({ nodeCount: 2, edgeCount: 1, draggedNodeCount: 2 })
    time = 30
    recorder.finish('completed')
    expect(reports).toHaveLength(2)
    expect(reports[1]).toMatchObject({
      durationMs: 9,
      handler: { samples: 0 },
      frames: { samples: 0 },
      react: null,
    })
    expect(
      performance.getEntriesByName('plotweave.canvas.node-drag.editor'),
    ).toHaveLength(1)
    recorder.dispose()
  })

  it('处理器抛错仍传播原异常并记录失败，后续拖动可恢复', () => {
    const { recorder, reports } = setup()
    const failure = new Error('私密错误详情')
    recorder.start({ nodeCount: 1, edgeCount: 0, draggedNodeCount: 1 })
    expect(() =>
      recorder.measureChanges([], () => {
        time = 3
        throw failure
      }),
    ).toThrow(failure)
    recorder.finish('interrupted')
    expect(reports[0]).toMatchObject({
      handlerFailures: 1,
      handler: { totalMs: 3 },
      outcome: 'interrupted',
    })
    expect(JSON.stringify(reports)).not.toContain(failure.message)
    recorder.start({ nodeCount: 1, edgeCount: 0, draggedNodeCount: 1 })
    recorder.finish('completed')
    expect(reports[1]?.handlerFailures).toBe(0)
    recorder.dispose()
  })

  it('卸载清理未结束会话与已排队帧，不发布到已卸载消费者', () => {
    const { recorder, reports } = setup()
    recorder.start({ nodeCount: 1, edgeCount: 0, draggedNodeCount: 1 })
    const staleFrame = [...frames.values()][0]!
    recorder.dispose()
    expect(frames.size).toBe(0)
    staleFrame(16)
    recorder.finish('completed')
    expect(frames.size).toBe(0)
    expect(reports).toEqual([])
  })
})

describe('浏览器能力降级', () => {
  it('时间线清理失败也不能阻断段末报告或下一次拖动', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(performance, 'clearMeasures').mockImplementation(() => {
      throw new Error('unsupported')
    })
    const { recorder, reports } = setup()
    recorder.start({ nodeCount: 1, edgeCount: 0, draggedNodeCount: 1 })
    expect(() => recorder.finish('completed')).not.toThrow()
    recorder.start({ nodeCount: 1, edgeCount: 0, draggedNodeCount: 1 })
    expect(() => recorder.finish('completed')).not.toThrow()
    expect(reports).toHaveLength(2)
    expect(() => recorder.dispose()).not.toThrow()
  })

  it('longtask 注册失败、measure 不可用时仍能输出其他数据', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    class UnavailableObserver {
      static supportedEntryTypes = ['longtask']
      observe() {
        throw new Error('unavailable')
      }
      disconnect() {}
    }
    vi.stubGlobal('PerformanceObserver', UnavailableObserver)
    vi.spyOn(performance, 'measure').mockImplementation(() => {
      throw new Error('unsupported')
    })
    const { recorder, reports } = setup()
    recorder.start({ nodeCount: 1, edgeCount: 0, draggedNodeCount: 1 })
    frame(16)
    recorder.finish('completed')
    expect(reports[0]).toMatchObject({
      longTasks: null,
      frames: { samples: 1, maxMs: 16 },
      react: null,
    })
    recorder.dispose()
  })

  it('结束时接收未投递的长任务，只聚合与本段相交的条目并断开观察器', () => {
    let disconnected = false
    let pending: PerformanceEntry[] = []
    class Observer {
      static supportedEntryTypes = ['longtask']
      observe() {}
      takeRecords() {
        const result = pending
        pending = []
        return result
      }
      disconnect() {
        disconnected = true
      }
    }
    vi.stubGlobal('PerformanceObserver', Observer)
    const { recorder, reports } = setup()
    time = 100
    recorder.start({ nodeCount: 1, edgeCount: 0, draggedNodeCount: 1 })
    pending = [
      { startTime: 0, duration: 50 },
      { startTime: 90, duration: 60 },
      { startTime: 150, duration: 80 },
    ] as PerformanceEntry[]
    time = 250
    recorder.finish('completed')
    expect(reports[0]?.longTasks).toEqual({
      samples: 2,
      totalMs: 140,
      maxMs: 80,
    })
    expect(disconnected).toBe(true)
    recorder.dispose()
  })
})
