/** #849：冲刷结果绑定完成时的画布 owner，不把后续新增编辑或旧 owner 归为失败。 */
import { afterEach, expect, it, vi } from 'vitest'
import {
  flushPendingCanvasSaves,
  registerCanvasFlushGate,
} from './canvasSaveRegistry'

afterEach(() => registerCanvasFlushGate(null))

it('没有画布 owner 时返回无失败', async () => {
  expect(await flushPendingCanvasSaves()).toBeNull()
})

it('冲刷落定仍有未落盘内容时显式返回失败', async () => {
  const flush = vi.fn(async () => undefined)
  registerCanvasFlushGate({ revision: () => 0, hasPending: () => true, flush })
  const failure = await flushPendingCanvasSaves()
  expect(failure?.()).toBe(true)
  expect(flush).toHaveBeenCalledTimes(1)
})

it('冲刷清脏后返回成功', async () => {
  let pending = true
  registerCanvasFlushGate({
    revision: () => 0,
    hasPending: () => pending,
    flush: async () => {
      pending = false
    },
  })
  expect(await flushPendingCanvasSaves()).toBeNull()
})

it.each([
  null,
  { revision: () => 0, hasPending: () => true, flush: async () => undefined },
])('冲刷期间 owner 注销或替换，不返回旧 owner 的失败', async (next) => {
  registerCanvasFlushGate({
    revision: () => 0,
    hasPending: () => true,
    flush: async () => {
      registerCanvasFlushGate(next)
    },
  })
  expect(await flushPendingCanvasSaves()).toBeNull()
})

it('异常保留原错误，由退出屏障统一取消退出', async () => {
  const error = new Error('owner unavailable')
  registerCanvasFlushGate({
    revision: () => 0,
    hasPending: () => true,
    flush: async () => {
      throw error
    },
  })
  await expect(flushPendingCanvasSaves()).rejects.toBe(error)
})

it('冲刷后替换 owner，最终探针不会把旧失败套到新画布', async () => {
  registerCanvasFlushGate({
    revision: () => 0,
    hasPending: () => true,
    flush: async () => undefined,
  })
  const failure = await flushPendingCanvasSaves()
  registerCanvasFlushGate({
    revision: () => 0,
    hasPending: () => true,
    flush: async () => undefined,
  })
  expect(failure?.()).toBe(false)
})

it('冲刷后编辑水位前进，最终探针不继承旧失败', async () => {
  let revision = 1
  registerCanvasFlushGate({
    revision: () => revision,
    hasPending: () => true,
    flush: async () => undefined,
  })
  const failure = await flushPendingCanvasSaves()
  revision += 1
  expect(failure?.()).toBe(false)
})

it('同一水位被项目重试清脏后，最终探针允许退出', async () => {
  let pending = true
  registerCanvasFlushGate({
    revision: () => 0,
    hasPending: () => pending,
    flush: async () => undefined,
  })
  const failure = await flushPendingCanvasSaves()
  pending = false
  expect(failure?.()).toBe(false)
})
