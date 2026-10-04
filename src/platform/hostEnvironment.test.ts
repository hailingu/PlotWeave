import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  detectHostKind,
  isBrowserPreviewHost,
  isNativeHost,
  isSwiftHost,
  isTauriHost,
} from './hostEnvironment'

/**
 * 宿主识别（docs/swiftui-react-flow-migration-plan.md §3、矩阵 M16）：
 * 识别是纯函数、单一来源，优先级 tauri > swift > browser；
 * 内存回退仅属纯浏览器预览，Swift 标记形状非法不识别为 swift。
 */

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('detectHostKind 宿主识别优先级', () => {
  it('无窗口（Node 测试环境）识别为纯浏览器预览', () => {
    expect(detectHostKind(undefined)).toBe('browser')
  })

  it('Tauri IPC 桥存在时优先识别为 tauri（即使同时带有原生标记）', () => {
    expect(
      detectHostKind({
        __TAURI_INTERNALS__: {},
        __pwNativeHost: { kind: 'swift' },
      }),
    ).toBe('tauri')
  })

  it('原生注入的 __pwNativeHost={kind:"swift"} 识别为 swift 宿主', () => {
    expect(detectHostKind({ __pwNativeHost: { kind: 'swift' } })).toBe('swift')
  })

  it('标记形状非法（缺 kind / 错值 / 原始值 / 空对象）不识别为 swift，落回 browser', () => {
    expect(detectHostKind({ __pwNativeHost: {} })).toBe('browser')
    expect(detectHostKind({ __pwNativeHost: { kind: 'electron' } })).toBe(
      'browser',
    )
    expect(detectHostKind({ __pwNativeHost: 'swift' })).toBe('browser')
    expect(detectHostKind({})).toBe('browser')
  })
})

describe('宿主谓词读取调用时刻的全局 window', () => {
  it('swift 宿主：isSwiftHost 真、isNativeHost 真、不属内存回退宿主', () => {
    vi.stubGlobal('window', { __pwNativeHost: { kind: 'swift' } })
    expect(isSwiftHost()).toBe(true)
    expect(isNativeHost()).toBe(true)
    expect(isBrowserPreviewHost()).toBe(false)
  })

  it('tauri 宿主：isTauriHost 真、isNativeHost 真', () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    expect(isTauriHost()).toBe(true)
    expect(isNativeHost()).toBe(true)
  })

  it('无标记窗口：仅 isBrowserPreviewHost 真（唯一允许内存回退的宿主）', () => {
    vi.stubGlobal('window', {})
    expect(isBrowserPreviewHost()).toBe(true)
    expect(isNativeHost()).toBe(false)
    expect(isTauriHost()).toBe(false)
    expect(isSwiftHost()).toBe(false)
  })
})

/** 与 dev 的运行环境判定契约一致：桥属性存在即优先识别 Tauri。 */
it('Tauri 桥值为 undefined 时仍优先 Swift 标记', () => {
  expect(
    detectHostKind({
      __TAURI_INTERNALS__: undefined,
      __pwNativeHost: { kind: 'swift' },
    }),
  ).toBe('tauri')
})
