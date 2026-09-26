// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 引导加载失败通道（issue #358 评审 4111703397）：bootstrap 对应用
 * 本体的动态导入失败必须经被调方自有通道（.catch）结构化上报——
 * typescript-standard 的 fire-and-forget 约定要求 void 标记的承诺由
 * 被调方持有错误通道，不得依赖 unhandledrejection 全局兜底。./main
 * 桩以拒绝工厂模拟 chunk 拉取失败。
 */
vi.mock('./main', () => Promise.reject(new Error('chunk fetch failed')))

describe('引导加载失败通道（issue #358 评审 4111703397）', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('动态导入失败经被调方自有通道输出 BOOTSTRAP_LOAD_FAILED 结构化诊断', async () => {
    await import('./bootstrap')
    const spy = vi.mocked(console.error)
    await vi.waitFor(() => expect(spy).toHaveBeenCalled())
    // message 不钉文案：vi.mock 工厂拒绝被 vitest 包一层包装 Error，
    // 生产环境的 message 是真实的 chunk 拉取/求值错误原样字符串化
    expect(spy.mock.calls[0]?.[1]).toMatchObject({
      code: 'BOOTSTRAP_LOAD_FAILED',
      message: expect.any(String),
    })
  })
})
