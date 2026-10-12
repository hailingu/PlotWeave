// @vitest-environment happy-dom
/** 退出租约在完整操作落定、失败、旧 owner 清理与既有 inert 状态之间保持互斥。 */
import { afterEach, expect, it } from 'vitest'
import {
  beginWebExitFence,
  hasPendingWebOperations,
  isWebExitPending,
  registerWebStateCommit,
  runWebOperation,
  type WebExitFence,
} from './webExitFence'

const fences: WebExitFence[] = []
afterEach(() => {
  fences.forEach((fence) => fence.release())
  fences.length = 0
})

it('已接纳完整业务继续交付，新业务拒绝，状态提交确认后才完成排空', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let outcome = 0
  const work = runWebOperation(async () => {
    await gate
    outcome = 7
  })
  const fence = beginWebExitFence(() => {})
  fences.push(fence)
  const commit = registerWebStateCommit()
  let drained = false
  const wait = fence.wait().then(() => {
    drained = true
  })
  await expect(
    runWebOperation(async () => {
      outcome = 99
    }),
  ).rejects.toThrow(/PW_WEB_EXIT_PENDING/)
  expect(outcome).toBe(0)
  release()
  await work
  expect(outcome).toBe(7)
  expect(drained).toBe(false)
  commit()
  await wait
  expect(hasPendingWebOperations()).toBe(false)
  fence.seal()
  expect(registerWebStateCommit).toThrow(/PW_WEB_EXIT_PENDING/)
})

it('业务拒绝保持原错误，排空可结束，失败恢复后新操作可执行', async () => {
  let reject!: (error: Error) => void
  const work = runWebOperation(
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail
      }),
  )
  const failure = expect(work).rejects.toThrow('owned failure')
  const fence = beginWebExitFence(() => {})
  fences.push(fence)
  const wait = fence.wait()
  reject(new Error('owned failure'))
  await failure
  await wait
  fence.release()
  expect(isWebExitPending()).toBe(false)
  expect(await runWebOperation(async () => 3)).toBe(3)
})

it('旧租约重复释放不能解除新租约，恢复输入保留原 inert 值', () => {
  const wasInert = document.body.inert
  document.body.inert = true
  try {
    const old = beginWebExitFence(() => {})
    fences.push(old)
    old.release()
    const current = beginWebExitFence(() => {})
    fences.push(current)
    old.release()
    expect(isWebExitPending()).toBe(true)
    current.release()
    expect(document.body.inert).toBe(true)
  } finally {
    document.body.inert = wasInert
  }
})
