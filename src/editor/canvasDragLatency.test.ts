// @vitest-environment happy-dom
/** 固定时钟与真实 DOM 观察验证输入／坐标延迟，不把 DOM 更新当成屏幕绘制。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCanvasDragLatency } from './canvasDragLatency'

let time = 0

beforeEach(() => {
  time = 0
  vi.spyOn(performance, 'now').mockImplementation(() => time)
})

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** 事件创建时间与收到回调时间分开推进，模拟真实排队时间。 */
function event(at: number) {
  const value = new MouseEvent('mousemove')
  Object.defineProperty(value, 'timeStamp', { value: at })
  return value
}

/** 使用真实内联 CSS 变换，采样不能改写 transform 或强制布局。 */
function setup() {
  const node = document.createElement('div')
  node.style.transform = 'translate(0px,0px)'
  document.body.append(node)
  const sampler = createCanvasDragLatency(node)
  return { node, sampler }
}

describe('输入与主节点 DOM 延迟', () => {
  it('只在真实 DOM 追到最新位置后记录延迟，刷新中的差距也可见', async () => {
    const { node, sampler } = setup()
    time = 10
    sampler.move(event(4), { x: 3, y: 4 })
    time = 16
    sampler.frame()
    expect(node.style.transform).toBe('translate(0px,0px)')
    time = 24
    node.style.transform = 'translate(3px,4px)'
    await new Promise((resolve) => setTimeout(resolve, 0))
    time = 32
    sampler.frame()
    expect(sampler.finish()).toMatchObject({
      input: { events: 1, samples: 1, totalMs: 6, maxMs: 6 },
      dom: {
        updates: 1,
        matched: { samples: 1, totalMs: 14, maxMs: 14 },
        frameSamples: 2,
        behindFrames: 1,
        maxPositionGap: 5,
        pendingAtStop: false,
      },
    })
  })

  it('同一事件的 auto-pan 仍更新期望位置，连续覆盖不虚报已匹配', () => {
    const { node, sampler } = setup()
    const source = event(1)
    time = 4
    sampler.move(source, { x: 10, y: 0 })
    time = 8
    sampler.move(source, { x: 20, y: 0 })
    time = 12
    sampler.move(event(10), { x: 30, y: 0 })
    time = 16
    node.style.transform = 'translate(30px,0px)'
    const report = sampler.finish()
    expect(report).toMatchObject({
      input: { events: 2, samples: 2, totalMs: 5, maxMs: 3 },
      dom: { updates: 3, superseded: 2, matched: { samples: 1, maxMs: 4 } },
    })
    expect(report.input?.intervals).toMatchObject({ samples: 1, maxMs: 8 })
    node.style.transform = 'translate(999px,0px)'
    sampler.move(event(10), { x: 999, y: 0 })
    sampler.frame()
    expect(sampler.finish()).toEqual(report)
  })
})

describe('输入与主节点 DOM 延迟（待匹配与无效时间）', () => {
  it('松手前未匹配明确计入 pending，移除或无法解析的节点不计为跟上', () => {
    const { node, sampler } = setup()
    time = 2
    sampler.move(event(1), { x: 10, y: 0 })
    node.style.transform = 'scale(2)'
    sampler.frame()
    node.remove()
    sampler.frame()
    expect(sampler.finish().dom).toMatchObject({
      matched: { samples: 0 },
      frameSamples: 0,
      unreadableFrames: 2,
      pendingAtStop: true,
    })
  })

  it('曾匹配后又被旧 DOM 坐标覆盖，刷新与结束仍报告落后', () => {
    const { node, sampler } = setup()
    time = 2
    node.style.transform = 'translate(10px,0px)'
    sampler.move(event(1), { x: 10, y: 0 })
    time = 4
    node.style.transform = 'translate(0px,0px)'
    sampler.frame()
    expect(sampler.finish().dom).toMatchObject({
      matched: { samples: 1 },
      behindFrames: 1,
      maxPositionGap: 10,
      pendingAtStop: true,
    })
  })

  it.each(['MutationObserver', 'DOMMatrixReadOnly'])(
    '缺少 %s 时保留输入统计，非法时间不伪装成零延迟',
    (capability) => {
      vi.stubGlobal(capability, undefined)
      const { sampler } = setup()
      time = 5
      sampler.move(event(Number.NaN), { x: 1, y: 0 })
      time = 50
      sampler.move(event(51), { x: 2, y: 0 })
      const report = sampler.finish()
      expect(report.dom).toBeNull()
      expect(report.input).toMatchObject({
        events: 2,
        samples: 0,
        invalidTimestamps: 2,
        intervals: { samples: 1, maxMs: 45, over32Ms: 1 },
      })
    },
  )
})

describe('输入与主节点 DOM 延迟（观察器降级与清理）', () => {
  it('观察器注册失败明确降级，卸载后的旧回调不能改变独立新段', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.stubGlobal(
      'MutationObserver',
      class {
        observe() {
          throw new Error('私密失败内容')
        }
        disconnect() {}
      },
    )
    const { sampler } = setup()
    expect(warn).toHaveBeenCalledWith(
      '[CanvasPerf]',
      {
        code: 'DOM_LATENCY_OBSERVER_UNAVAILABLE',
      },
      {
        level: 'WARN',
        target: 'plotweave::frontend::canvas',
        code: 'DOM_LATENCY_OBSERVER_UNAVAILABLE',
        message: '[CanvasPerf]',
      },
    )
    sampler.dispose()
    sampler.move(event(1), { x: 1, y: 0 })
    expect(sampler.finish()).toEqual({ input: null, dom: null })
    vi.unstubAllGlobals()
    const next = setup()
    expect(next.sampler.finish().dom?.updates).toBe(0)
  })

  it('结束前未投递的 DOM 匹配会排空，卸载后的过期通知不会串段', () => {
    const RealObserver = MutationObserver
    let stale: MutationCallback | undefined
    vi.stubGlobal(
      'MutationObserver',
      class extends RealObserver {
        constructor(callback: MutationCallback) {
          super(callback)
          stale = callback
        }
      },
    )
    const first = setup()
    time = 5
    first.sampler.move(event(3), { x: 20, y: 0 })
    time = 9
    first.node.style.transform = 'translate(20px,0px)'
    const report = first.sampler.finish()
    const before = JSON.stringify(report)
    expect(report.dom).toMatchObject({
      matched: { samples: 1, maxMs: 4 },
      pendingAtStop: false,
    })
    stale?.([], new RealObserver(() => undefined))
    expect(JSON.stringify(report)).toBe(before)
    const next = setup()
    expect(next.sampler.finish()).toMatchObject({
      input: null,
      dom: { updates: 0, matched: { samples: 0 } },
    })
  })
})
