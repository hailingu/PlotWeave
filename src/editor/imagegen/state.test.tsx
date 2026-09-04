// @vitest-environment happy-dom
/**
 * 生成调度状态机（state.ts）的行为测试（§13 文生图，评审修复）：
 * ① 设置加载的异步间隙内重复发起（双击）只允许一个作业进入 Rust 生成——
 *    防重复计费请求与结果孤儿化；② EditorView 卸载（⌘, 设置页 / 返回
 * 首页）时对 running 作业发协作式取消，且完成回调不再写回已卸载组件。
 * 经最小 Harness 组件直挂 useImageJobsState，桌面态以 __TAURI_INTERNALS__ 模拟。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import type { AppSettings } from '../../settings/types'
import { settingsStore } from '../../settings/settingsStore'
import { normalizeAssetRef, tauriInvoke } from '../projectAssets'
import { useImageJobsState } from './state'
import type { ImageGenApi } from './context'
import type { AssetRef } from '../../model/document'
import type { CanvasNode, ImageFlowNode } from '../nodes/types'

vi.mock('../projectAssets', () => ({
  projectAssets: { importFromLibrary: vi.fn(), mediaUrl: vi.fn() },
  tauriInvoke: vi.fn(),
  normalizeAssetRef: vi.fn(),
}))

vi.mock('../../settings/settingsStore', () => ({
  settingsStore: { load: vi.fn() },
}))

afterEach(() => {
  cleanup()
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  vi.clearAllMocks()
})

/** 三层过滤可用的图像模型设置：defaultImage 指向已启用 provider 的清单内模型。 */
const validSettings: AppSettings = {
  providers: [
    {
      id: 'pv',
      label: 'PV',
      baseUrl: 'https://api.example.com',
      enabled: true,
      models: ['img-m1'],
      keyEnc: 'pw1:x',
    },
  ],
  defaultChat: null,
  defaultImage: 'pv:img-m1',
}

function imageNodeData(): ImageFlowNode['data'] {
  return { prompt: '雨夜霓虹', model: '', size: '1024x1024', outputs: {} }
}

/** 最小 Harness：挂 useImageJobsState 并把 api 暴露给测试。 */
function Harness(props: {
  readonly nodesRef: { current: CanvasNode[] }
  readonly patchNode: (id: string, patch: Record<string, unknown>) => void
  readonly addAsset: (asset: AssetRef) => void
}) {
  const { api } = useImageJobsState({
    projectId: 'p-1',
    nodesRef: props.nodesRef,
    patchNode: props.patchNode,
    addAsset: props.addAsset,
  })
  apiRef = api
  return null
}

let apiRef: ImageGenApi | null = null

/** llm_image_generate 的调用次数。 */
function generateCount(): number {
  return vi.mocked(tauriInvoke).mock.calls.filter(([cmd]) => cmd === 'llm_image_generate')
    .length
}

/** 已发起生成的 jobId（取自唯一一次调用的请求载荷）。 */
function generatedJobId(): string {
  const call = vi
    .mocked(tauriInvoke)
    .mock.calls.find(([cmd]) => cmd === 'llm_image_generate')
  return (call?.[1] as { request: { jobId: string } } | undefined)?.request.jobId ?? ''
}

function setupHarness(opts: { resolveSettings?: Promise<AppSettings> } = {}) {
  vi.mocked(settingsStore.load).mockImplementation(() => opts.resolveSettings ?? Promise.resolve(validSettings))
  const patchNode = vi.fn()
  const addAsset = vi.fn()
  const nodesRef = {
    current: [{ id: 'img1', type: 'image', data: imageNodeData() } as unknown as CanvasNode],
  }
  render(<Harness nodesRef={nodesRef} patchNode={patchNode} addAsset={addAsset} />)
  return { patchNode, addAsset }
}

describe('生成调度状态机（§13）', () => {
  it('设置加载的异步间隙内双击只发起一次生成（防重复计费与结果孤儿化）', async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    let resolveSettings!: (s: AppSettings) => void
    const gate = new Promise<AppSettings>((res) => {
      resolveSettings = res
    })
    vi.mocked(tauriInvoke).mockImplementation((cmd: string) => {
      if (cmd === 'llm_image_generate') return new Promise(() => {})
      return Promise.resolve({})
    })
    setupHarness({ resolveSettings: gate })

    void apiRef!.start('img1')
    void apiRef!.start('img1') // 双击：设置 IPC 未返回，作业尚未登记
    resolveSettings(validSettings)

    await waitFor(() => expect(generateCount()).toBeGreaterThan(0))
    await new Promise((r) => setTimeout(r, 0))
    expect(generateCount()).toBe(1)
  })

  it('卸载时对 running 作业发协作式取消，完成结果不写回已卸载组件', async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    let resolveGen!: (v: unknown) => void
    vi.mocked(tauriInvoke).mockImplementation((cmd: string) => {
      if (cmd === 'llm_image_generate') return new Promise((res) => (resolveGen = res))
      return Promise.resolve({})
    })
    vi.mocked(normalizeAssetRef).mockImplementation((raw) => raw as unknown as AssetRef)
    const { patchNode, addAsset } = setupHarness()

    void apiRef!.start('img1')
    await waitFor(() => expect(generateCount()).toBe(1))
    const jobId = generatedJobId()
    expect(jobId).not.toBe('')

    cleanup() // 卸载 EditorView 等价：Provider 卸载
    expect(tauriInvoke).toHaveBeenCalledWith('llm_image_cancel', { jobId })

    resolveGen({ id: 'pa-1' })
    await new Promise((r) => setTimeout(r, 0))
    expect(patchNode).not.toHaveBeenCalled()
    expect(addAsset).not.toHaveBeenCalled()
  })
})
