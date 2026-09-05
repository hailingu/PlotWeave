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
import { useRef } from 'react'
import type { AppSettings } from '../../settings/types'
import { settingsStore } from '../../settings/settingsStore'
import { normalizeAssetRef, projectAssets, tauriInvoke } from '../projectAssets'
import { useImageJobsState, doomedImageAssets } from './state'
import type { ImageGenApi } from './context'
import type { CharacterEntity, ProjectSettings } from '../settings'
import type { HistoryCommand } from '../history'
import type { AssetRef } from '../../model/document'
import type { CanvasNode, ImageFlowNode } from '../nodes/types'
import type { NodeDataPatch } from '../nodes/patch'

vi.mock('../projectAssets', () => ({
  projectAssets: { importFromLibrary: vi.fn(), mediaUrl: vi.fn(), revalidate: vi.fn() },
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

/** 最小 Harness：挂 useImageJobsState 并把 api 暴露给测试；nodesRef 镜像
 * nodes 属性（复刻 EditorView 的「状态 + ref 镜像」模式）。 */
function Harness(props: {
  readonly nodes: CanvasNode[]
  readonly assetsRef: { current: { byId: Record<string, AssetRef> } | undefined }
  readonly settings: Pick<ProjectSettings, 'characters'> & { locations?: unknown }
  readonly applyDataPatch: (id: string, cmd: NodeDataPatch) => void
  readonly addAsset: (asset: AssetRef) => void
  readonly removeAsset: (assetId: string) => void
  readonly pushHistory: (cmd: HistoryCommand) => void
}) {
  const nodesRef = useRef(props.nodes)
  nodesRef.current = props.nodes
  const { api } = useImageJobsState({
    projectId: 'p-1',
    nodes: props.nodes,
    nodesRef,
    assetsRef: props.assetsRef,
    settingsRef: { current: props.settings },
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

/** 生成成功路径的公共脚手架：gen 返回 pa-9（§9.3 预检已在命令内，单 IPC）。 */
function mockSuccessfulGeneration(): void {
  vi.mocked(tauriInvoke).mockImplementation((cmd: string) => {
    if (cmd === 'llm_image_generate') {
      return Promise.resolve({
        id: 'pa-9',
        relPath: 'assets/pa-9.png',
        mime: 'image/png',
        source: 'generated',
        createdAt: '2026-09-04T00:00:00.000Z',
      })
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
    characters?: ProjectSettings['characters']
  } = {},
) {
  vi.mocked(settingsStore.load).mockImplementation(() => opts.resolveSettings ?? Promise.resolve(validSettings))
  const cmds = {
    applyDataPatch: vi.fn(),
    addAsset: vi.fn(),
    removeAsset: vi.fn(),
    pushHistory: vi.fn(),
  }
  const nodes = opts.nodes ?? [{ id: 'img1', type: 'image', data: imageNodeData() } as unknown as CanvasNode]
  const assetsRef = { current: opts.assets }
  const settings = { characters: opts.characters ?? [], locations: [] as never[] }
  const view = render(<Harness nodes={nodes} assetsRef={assetsRef} settings={settings} {...cmds} />)
  /** 模拟节点表变化（删除/复活）——重挂同一 Harness 换 nodes。 */
  const setNodes = (next: CanvasNode[]) =>
    view.rerender(<Harness nodes={next} assetsRef={assetsRef} settings={settings} {...cmds} />)
  return { ...cmds, setNodes }
}

describe('生成调度：发起与双击占位（§13）', () => {
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
})

describe('生成调度：设置加载失败（§13）', () => {
  it('设置 load 拒绝：作业转入错误态并显示诊断，再次生成不被 running 守卫挡死', async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    vi.mocked(tauriInvoke).mockImplementation((cmd: string) => {
      if (cmd === 'llm_image_generate') return new Promise(() => {})
      return Promise.resolve({})
    })
    setupHarness({ resolveSettings: Promise.reject(new Error('prefs IPC 失败')) })

    void apiRef!.start('img1')
    // start 丢弃 runStart 的 promise：load 拒绝若逃出未处理，占位永远停在
    // running、无诊断，后续生成被 running 守卫挡死
    await waitFor(() => expect(apiRef!.jobOf('img1')?.status).toBe('error'))
    expect((apiRef!.jobOf('img1') as { message: string }).message).toContain('加载设置失败')

    // 错误态可重试：第二次发起进入生成（设置恢复后正常计费一次）
    vi.mocked(settingsStore.load).mockImplementation(() => Promise.resolve(validSettings))
    void apiRef!.start('img1')
    await waitFor(() => expect(generateCount()).toBe(1))
  })
})

describe('生成调度：卸载协作式取消（§13 作业生命周期）', () => {
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
})

describe('生成调度：结果落位复合命令（§7.3 同构）', () => {
  it('生成成功以复合命令入栈：undo 同步移除资产索引，redo 恢复（§7.3 同构）', async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    mockSuccessfulGeneration()
    const { applyDataPatch, addAsset, removeAsset, pushHistory } = setupHarness()

    void apiRef!.start('img1')
    await waitFor(() => expect(pushHistory).toHaveBeenCalledTimes(1))
    // 初始应用：资产入索引 + outputs 写回（纯状态写入，非 patchNode 命令）
    expect(addAsset).toHaveBeenCalledTimes(1)
    expect(applyDataPatch).toHaveBeenCalledWith('img1', {
      nodeType: 'image',
      patch: { outputs: { primary: { assetId: 'pa-9' } } },
    })

    const cmd = vi.mocked(pushHistory).mock.calls[0][0] as HistoryCommand
    cmd.undo()
    expect(removeAsset).toHaveBeenCalledWith('pa-9')
    expect(applyDataPatch).toHaveBeenLastCalledWith('img1', {
      nodeType: 'image',
      patch: { outputs: {} },
    })
    cmd.redo()
    expect(addAsset).toHaveBeenCalledTimes(2)
    expect(applyDataPatch).toHaveBeenLastCalledWith('img1', {
      nodeType: 'image',
      patch: { outputs: { primary: { assetId: 'pa-9' } } },
    })

    // 重做防线（issue #10）：redoGuard 经 projectAssets.revalidate 复验生成产物
    expect(cmd.redoGuard).toBeTypeOf('function')
    vi.mocked(projectAssets.revalidate).mockResolvedValue(undefined)
    await cmd.redoGuard?.()
    expect(projectAssets.revalidate).toHaveBeenCalledWith('p-1', expect.objectContaining({ id: 'pa-9' }))
  })
})

describe('生成调度：宿主节点删除（§13 作业生命周期）', () => {
  it('running 作业的宿主节点被删：协作式取消并清作业表（undo 复活后重新生成）', async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    vi.mocked(tauriInvoke).mockImplementation((cmd: string) => {
      if (cmd === 'llm_image_generate') return new Promise(() => {})
      return Promise.resolve({})
    })
    const { setNodes } = setupHarness()

    void apiRef!.start('img1')
    await waitFor(() => expect(generateCount()).toBe(1))
    const jobId = generatedJobId()

    setNodes([]) // 删除 img1：Provider 仍挂载，靠节点观察取消
    await waitFor(() => expect(tauriInvoke).toHaveBeenCalledWith('llm_image_cancel', { jobId }))
  })

  it('设置加载间隙中宿主节点被删：提交前复核，不发起计费请求', async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    let resolveSettings!: (s: AppSettings) => void
    const gate = new Promise<AppSettings>((res) => {
      resolveSettings = res
    })
    vi.mocked(tauriInvoke).mockImplementation((cmd: string) => {
      if (cmd === 'llm_image_generate') return new Promise(() => {})
      return Promise.resolve({})
    })
    const { setNodes } = setupHarness({ resolveSettings: gate })

    void apiRef!.start('img1')
    setNodes([]) // 设置 IPC 未返回时删除节点
    resolveSettings(validSettings)
    await new Promise((r) => setTimeout(r, 0))
    expect(generateCount()).toBe(0)
  })
})

describe('生成调度：作业身份复核（§13）', () => {
  it('被取消作业的设置加载迟到返回：不覆盖接替作业，接替作业结果正常落位', async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    let gateA!: (s: AppSettings) => void
    const settingsOfA = new Promise<AppSettings>((res) => {
      gateA = res
    })
    vi.mocked(tauriInvoke).mockImplementation((cmd: string) => {
      if (cmd === 'llm_image_generate') {
        return Promise.resolve({
          id: 'pa-b',
          relPath: 'assets/pa-b.png',
          mime: 'image/png',
          source: 'generated',
          createdAt: '2026-09-04T00:00:00.000Z',
        })
      }
      return Promise.resolve({})
    })
    vi.mocked(normalizeAssetRef).mockImplementation((raw) => raw as unknown as AssetRef)
    const { pushHistory } = setupHarness()
    // 计数型 load mock（覆盖 setupHarness 的默认）：首次挂起给 A，此后
    // 立即给 B 有效设置——两个作业不得共享同一个挂起的 Promise
    let loadCall = 0
    vi.mocked(settingsStore.load).mockImplementation(() => {
      loadCall += 1
      return loadCall === 1 ? settingsOfA : Promise.resolve(validSettings)
    })

    void apiRef!.start('img1') // 作业 A：设置加载在途
    apiRef!.cancel('img1') // 取消 A（清表）；用户改好输入后立即重启
    void apiRef!.start('img1') // 作业 B：接替
    gateA({ ...validSettings, defaultImage: null }) // A 的设置迟到返回且计划不可解析

    await waitFor(() => expect(pushHistory).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 0))
    // B 的结果必须落位：A 的迟到分支不得以 error 覆盖 B 的 running
    expect(pushHistory).toHaveBeenCalledTimes(1)
  })
})

describe('生成调度：旧产物回收（§7.3）', () => {
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
})

describe('生成调度：旧产物被引用或悬空不回收（§7.3）', () => {
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

  it('旧产物同时是角色头像（avatarAssetId）：不移出索引', async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    mockSuccessfulGeneration()
    const { removeAsset, pushHistory } = setupHarness({
      nodes: [
        {
          id: 'img1',
          type: 'image',
          data: { ...imageNodeData(), outputs: { primary: { assetId: 'pa-old' } } },
        } as unknown as CanvasNode,
      ],
      assets: { byId: { 'pa-old': {} as AssetRef } },
      // 落盘模型可携带 avatarAssetId（CharacterEntity 未声明、serialize 整对象透传）
      characters: [
        { id: 'ch1', name: '林晚', gradient: 'g', avatarAssetId: 'pa-old' } as CharacterEntity,
      ],
    })
    void apiRef!.start('img1')
    await waitFor(() => expect(pushHistory).toHaveBeenCalledTimes(1))
    expect(removeAsset).not.toHaveBeenCalledWith('pa-old')
  })

  it('悬空 primary 的 assetId 为原型链键名（__proto__）：不把继承值当旧产物', async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    mockSuccessfulGeneration()
    const { removeAsset, pushHistory } = setupHarness({
      nodes: [
        {
          id: 'img1',
          type: 'image',
          data: { ...imageNodeData(), outputs: { primary: { assetId: '__proto__' } } },
        } as unknown as CanvasNode,
      ],
      assets: { byId: {} },
    })
    void apiRef!.start('img1')
    await waitFor(() => expect(pushHistory).toHaveBeenCalledTimes(1))
    // byId 无自有 '__proto__' 键：不得命中 Object.prototype 当 AssetRef 回收
    expect(removeAsset).not.toHaveBeenCalled()
  })
})

describe('doomedImageAssets：删除图片节点的产物回收判定（§7.3）', () => {
  const imgWith = (assetId: string) =>
    ({
      id: 'img1',
      type: 'image',
      data: { ...imageNodeData(), outputs: { primary: { assetId } } },
    }) as unknown as CanvasNode
  const paOld: AssetRef = {
    id: 'pa-old',
    relPath: 'assets/pa-old.png',
    mime: 'image/png',
    source: 'generated',
    createdAt: '2026-09-01T00:00:00.000Z',
  }

  it('产物不再被幸存节点/头像引用且仍在索引：回收（含去重）', () => {
    const doomed = doomedImageAssets([imgWith('pa-old'), imgWith('pa-old')], [], [], {
      'pa-old': paOld,
    })
    expect(doomed).toEqual([paOld])
  })

  it('仍被幸存节点引用 / 头像引用 / 索引外悬空 / 原型链键名：不回收', () => {
    const survivorShot = {
      id: 'sh1',
      type: 'shot',
      data: { refs: [{ id: 'r1', kind: 'image', assetId: 'pa-old' }] },
    } as unknown as CanvasNode
    expect(doomedImageAssets([imgWith('pa-old')], [survivorShot], [], { 'pa-old': paOld })).toEqual([])
    expect(
      doomedImageAssets(
        [imgWith('pa-old')],
        [],
        [{ id: 'ch1', name: '林晚', gradient: 'g', avatarAssetId: 'pa-old' } as CharacterEntity],
        { 'pa-old': paOld },
      ),
    ).toEqual([])
    expect(doomedImageAssets([imgWith('pa-gone')], [], [], { 'pa-old': paOld })).toEqual([])
    expect(doomedImageAssets([imgWith('__proto__')], [], [], {})).toEqual([])
  })
})
