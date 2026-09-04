// @vitest-environment happy-dom
/**
 * 生成调度状态机（state.ts）的行为测试（§13 文生图，评审修复）：
 * ① 设置加载的异步间隙内重复发起（双击）只允许一个作业进入 Rust 生成——
 *    防重复计费请求与结果孤儿化；② EditorView 卸载（⌘, 设置页 / 返回
 * 首页）时对 running 作业发协作式取消，且完成回调不再写回已卸载组件；
 * ③ 生成成功以复合命令入栈——资产入索引与 outputs 写回同栈撤销/重做
 *    （§7.3 库资产导入同构）。
 * 经最小 Harness 组件直挂 useImageJobsState，桌面态以 __TAURI_INTERNALS__ 模拟。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import type { AppSettings } from '../../settings/types'
import { settingsStore } from '../../settings/settingsStore'
import { normalizeAssetRef, tauriInvoke } from '../projectAssets'
import { useImageJobsState } from './state'
import type { ImageGenApi } from './context'
import type { HistoryCommand } from '../history'
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
  readonly assetsRef: { current: { byId: Record<string, AssetRef> } | undefined }
  readonly applyDataPatch: (id: string, patch: Record<string, unknown>) => void
  readonly addAsset: (asset: AssetRef) => void
  readonly removeAsset: (assetId: string) => void
  readonly pushHistory: (cmd: HistoryCommand) => void
}) {
  const { api } = useImageJobsState({
    projectId: 'p-1',
    nodesRef: props.nodesRef,
    assetsRef: props.assetsRef,
    applyDataPatch: props.applyDataPatch,
    addAsset: props.addAsset,
    removeAsset: props.removeAsset,
    pushHistory: props.pushHistory,
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

/** 生成成功路径的公共脚手架：gen 返回 pa-9，validate 原样回显。 */
function mockSuccessfulGeneration(): void {
  vi.mocked(tauriInvoke).mockImplementation((cmd: string, args: unknown) => {
    if (cmd === 'llm_image_generate') {
      return Promise.resolve({
        id: 'pa-9',
        relPath: 'assets/pa-9.png',
        mime: 'image/png',
        source: 'generated',
        createdAt: '2026-09-04T00:00:00.000Z',
      })
    }
    if (cmd === 'validate_project_asset') {
      return Promise.resolve((args as { asset?: unknown } | undefined)?.asset ?? {})
    }
    return Promise.resolve({})
  })
  vi.mocked(normalizeAssetRef).mockImplementation((raw) => raw as unknown as AssetRef)
}

function setupHarness(
  opts: {
    resolveSettings?: Promise<AppSettings>
    nodes?: CanvasNode[]
    assets?: { byId: Record<string, AssetRef> }
  } = {},
) {
  vi.mocked(settingsStore.load).mockImplementation(() => opts.resolveSettings ?? Promise.resolve(validSettings))
  const cmds = {
    applyDataPatch: vi.fn(),
    addAsset: vi.fn(),
    removeAsset: vi.fn(),
    pushHistory: vi.fn(),
  }
  const nodesRef = {
    current:
      opts.nodes ?? ([{ id: 'img1', type: 'image', data: imageNodeData() } as unknown as CanvasNode]),
  }
  const assetsRef = { current: opts.assets }
  render(<Harness nodesRef={nodesRef} assetsRef={assetsRef} {...cmds} />)
  return cmds
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
    const { applyDataPatch, addAsset, pushHistory } = setupHarness()

    void apiRef!.start('img1')
    await waitFor(() => expect(generateCount()).toBe(1))
    const jobId = generatedJobId()
    expect(jobId).not.toBe('')

    cleanup() // 卸载 EditorView 等价：Provider 卸载
    expect(tauriInvoke).toHaveBeenCalledWith('llm_image_cancel', { jobId })

    resolveGen({ id: 'pa-1' })
    await new Promise((r) => setTimeout(r, 0))
    expect(applyDataPatch).not.toHaveBeenCalled()
    expect(addAsset).not.toHaveBeenCalled()
    expect(pushHistory).not.toHaveBeenCalled()
  })

  it('生成成功以复合命令入栈：undo 同步移除资产索引，redo 恢复（§7.3 同构）', async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    mockSuccessfulGeneration()
    const { applyDataPatch, addAsset, removeAsset, pushHistory } = setupHarness()

    void apiRef!.start('img1')
    await waitFor(() => expect(pushHistory).toHaveBeenCalledTimes(1))
    // 初始应用：资产入索引 + outputs 写回（纯状态写入，非 patchNode 命令）
    expect(addAsset).toHaveBeenCalledTimes(1)
    expect(applyDataPatch).toHaveBeenCalledWith('img1', {
      outputs: { primary: { assetId: 'pa-9' } },
    })

    const cmd = vi.mocked(pushHistory).mock.calls[0][0] as HistoryCommand
    cmd.undo()
    expect(removeAsset).toHaveBeenCalledWith('pa-9')
    expect(applyDataPatch).toHaveBeenLastCalledWith('img1', { outputs: {} })
    cmd.redo()
    expect(addAsset).toHaveBeenCalledTimes(2)
    expect(applyDataPatch).toHaveBeenLastCalledWith('img1', {
      outputs: { primary: { assetId: 'pa-9' } },
    })
  })

  it('重新生成：旧产物不再被任何节点引用时随命令移出索引，undo 恢复（§7.3）', async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    mockSuccessfulGeneration()
    const oldAsset: AssetRef = {
      id: 'pa-old',
      relPath: 'assets/pa-old.png',
      mime: 'image/png',
      source: 'generated',
      createdAt: '2026-09-01T00:00:00.000Z',
    }
    const { addAsset, removeAsset, pushHistory } = setupHarness({
      nodes: [
        {
          id: 'img1',
          type: 'image',
          data: { ...imageNodeData(), outputs: { primary: { assetId: 'pa-old' } } },
        } as unknown as CanvasNode,
      ],
      assets: { byId: { 'pa-old': oldAsset } },
    })

    void apiRef!.start('img1')
    await waitFor(() => expect(pushHistory).toHaveBeenCalledTimes(1))
    // 替换即回收：旧产物移出索引（媒体文件留存待延迟回收，§7.3）
    expect(removeAsset).toHaveBeenCalledWith('pa-old')

    const cmd = vi.mocked(pushHistory).mock.calls[0][0] as HistoryCommand
    cmd.undo()
    expect(addAsset).toHaveBeenCalledWith(oldAsset)
    cmd.redo()
    expect(removeAsset).toHaveBeenLastCalledWith('pa-old')
  })

  it('旧产物仍被分镜卡引用（或已不在索引）：不移出索引', async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    mockSuccessfulGeneration()
    const referenced = setupHarness({
      nodes: [
        {
          id: 'img1',
          type: 'image',
          data: { ...imageNodeData(), outputs: { primary: { assetId: 'pa-old' } } },
        } as unknown as CanvasNode,
        {
          id: 'shot1',
          type: 'shot',
          data: { refs: [{ id: 'r1', kind: 'image', assetId: 'pa-old' }] },
        } as unknown as CanvasNode,
      ],
      assets: { byId: { 'pa-old': {} as AssetRef } },
    })
    void apiRef!.start('img1')
    await waitFor(() => expect(referenced.pushHistory).toHaveBeenCalledTimes(1))
    expect(referenced.removeAsset).not.toHaveBeenCalledWith('pa-old')

    const dangling = setupHarness({
      nodes: [
        {
          id: 'img1',
          type: 'image',
          data: { ...imageNodeData(), outputs: { primary: { assetId: 'pa-gone' } } },
        } as unknown as CanvasNode,
      ],
    })
    void apiRef!.start('img1')
    await waitFor(() => expect(dangling.pushHistory).toHaveBeenCalledTimes(1))
    expect(dangling.removeAsset).not.toHaveBeenCalledWith('pa-gone')
  })
})
