// @vitest-environment happy-dom
/**
 * 节点外壳共享行为的参数化套件（issue #534）：⚙️ 设置面板开关、双击内联
 * 改名 → patchNode、端口锚点布局三组 chrome 用例原在 5 个节点文件逐字
 * 维护，现按节点类型驱动收敛于此；各类型的差异用例（派生统计、失效
 * 兜底、资产生命周期等）留在其组件测试文件。Handle 依赖 React Flow
 * 仓库上下文，隔离渲染以锚点桩替代（testScaffolding.tsx）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { ReactFlowProvider, type NodeProps } from '@xyflow/react'
import { NodeEditContext, type NodeEditApi } from '../nodeEdit'
import { BRANCH_OPTION_HANDLE_PREFIX, SCENE_SHOT_HANDLE } from '../graphRules'
import { ImageGenProvider } from '../imagegen/ImageGenProvider'
import { makeNodeEditApi } from './testScaffolding'
import { BeatNode } from './BeatNode'
import { BranchNode } from './BranchNode'
import { DialogueNode } from './DialogueNode'
import { ImageNode } from './ImageNode'
import { SceneNode } from './SceneNode'
import { ShotNode } from './ShotNode'
import type { NodeDataPatch } from './patch'
import type {
  BeatFlowNode,
  BranchFlowNode,
  CanvasNode,
  DialogueFlowNode,
  ImageFlowNode,
  SceneFlowNode,
  ShotFlowNode,
} from './types'

vi.mock('@xyflow/react', async (importOriginal) =>
  (await import('./testScaffolding')).stubReactFlowHandleModule(
    await importOriginal<typeof import('@xyflow/react')>(),
  ),
)

afterEach(cleanup)

/** 外壳行为参数化表项：三组共享 chrome 用例按节点类型驱动的数据形状；
 * 表项注释保留合并前所在文件与用例名的溯源（issue #534 验收）。 */
interface NodeShellRow {
  /** 用例名前缀（节点类型，即原用例所在的组件测试文件）。 */
  readonly kind: string
  readonly id: string
  /** ⚙️ 齿轮可访问名；缺省 = 原文件无点击断言（仅覆盖展开态）。 */
  readonly settingsButton?: string
  /** openSettingsId 命中后的展开断言；缺省 = 原文件未覆盖展开态。 */
  readonly expectOpen?: () => void
  /** 以 openSettingsId 隔离渲染该节点，返回注入的 NodeEditApi。 */
  readonly render: (openSettingsId: string | null) => NodeEditApi
  /** 双击内联改名交互；缺省 = 该类型无内联改名用例。 */
  readonly rename?: {
    readonly button: string
    readonly input: string
    readonly value: string
    readonly cmd: NodeDataPatch
  }
  /** 端口锚点 testid 片段（handle- 之后的部分）；缺省 = 无端口断言。 */
  readonly ports?: readonly string[]
}

/** 隔离渲染公共包裹：React Flow 仓库上下文 + 节点编辑上下文。 */
function renderFlowNode(node: ReactElement, api: NodeEditApi) {
  render(
    <ReactFlowProvider>
      <NodeEditContext.Provider value={api}>{node}</NodeEditContext.Provider>
    </ReactFlowProvider>,
  )
}

/** 场景节点（索引卡）外壳渲染：原 SceneNode.test.tsx 的 SETTINGS/DATA 夹具。 */
function renderSceneShell(openSettingsId: string | null): NodeEditApi {
  const api = makeNodeEditApi({
    openSettingsId,
    shotCountOf: () => 2,
    settings: {
      characters: [{ id: 'c1', name: '林晚', gradient: 'g1' }],
      locations: [{ id: 'l1', name: '天台' }],
    },
  })
  renderFlowNode(
    <SceneNode
      {...({
        id: 's1',
        data: {
          name: '天台对峙',
          sceneNo: 3,
          interior: false,
          locationId: 'l1',
          time: '🌙 夜',
          weather: '🌧 雨',
          synopsis: '陈默坦白当年真相。',
          characterIds: ['c1'],
        },
        selected: true,
      } as unknown as NodeProps<SceneFlowNode>)}
    />,
    api,
  )
  return api
}

/** 对白节点（气泡流卡）外壳渲染：原 DialogueNode.test.tsx 的夹具。 */
function renderDialogueShell(openSettingsId: string | null): NodeEditApi {
  const api = makeNodeEditApi({
    openSettingsId,
    settings: {
      characters: [{ id: 'c1', name: '林晚', gradient: 'g1' }],
      locations: [],
    },
  })
  renderFlowNode(
    <DialogueNode
      {...({
        id: 'd1',
        data: {
          name: '真相逼近',
          lines: [
            {
              id: 'l1',
              kind: 'line',
              speaker: 'c1',
              side: 'left',
              text: '你早就知道',
            },
          ],
        },
        selected: false,
      } as unknown as NodeProps<DialogueFlowNode>)}
    />,
    api,
  )
  return api
}

/** 节奏卡（节拍胶囊）外壳渲染：原 BeatNode.test.tsx 的夹具。 */
function renderBeatShell(): NodeEditApi {
  const api = makeNodeEditApi()
  renderFlowNode(
    <BeatNode
      {...({
        id: 'b1',
        data: { name: '真相逼近', tone: '紧张' },
        selected: false,
      } as unknown as NodeProps<BeatFlowNode>)}
    />,
    api,
  )
  return api
}

/** 分支节点（岔路路标）外壳渲染：原 BranchNode.test.tsx 的夹具。 */
function renderBranchShell(openSettingsId: string | null): NodeEditApi {
  const api = makeNodeEditApi({ openSettingsId })
  renderFlowNode(
    <BranchNode
      {...({
        id: 'br1',
        data: {
          prompt: '林晚是否发现真相？',
          options: [
            { id: 'o1', label: '坦白' },
            { id: 'o2', label: '隐瞒' },
          ],
        },
        selected: false,
      } as unknown as NodeProps<BranchFlowNode>)}
    />,
    api,
  )
  return api
}

/** 分镜卡（监视器卡）外壳渲染：原 ShotNode.test.tsx 的夹具（标签引用位）。 */
function renderShotShell(openSettingsId: string | null): NodeEditApi {
  const api = makeNodeEditApi({ openSettingsId })
  renderFlowNode(
    <ShotNode
      {...({
        id: 'sh1',
        data: {
          shotNo: 3,
          size: '特写',
          picture: '档案袋里的旧照片特写。',
          prompt: 'extreme close-up, raindrops',
          refs: [
            { id: 'r1', kind: 'character', label: '林晚垫图' },
            { id: 'r2', kind: 'location', label: '天台底图' },
            { id: 'r3', kind: 'audio', label: '雨声' },
          ],
        },
        selected: false,
      } as unknown as NodeProps<ShotFlowNode>)}
    />,
    api,
  )
  return api
}

/** 图片节点（生成侧媒体节点）外壳渲染：原 ImageNode.test.tsx 的夹具，
 * 经 ImageGenProvider 双上下文隔离渲染（无 Handle，不需 ReactFlowProvider）。 */
function renderImageShell(openSettingsId: string | null): NodeEditApi {
  const api = makeNodeEditApi({ openSettingsId })
  const nodesRef = { current: [] as CanvasNode[] }
  const props = {
    id: 'img1',
    data: {
      prompt: '雨夜霓虹街道，中景',
      model: '',
      size: '1024x1536',
      outputs: {},
    },
    selected: false,
  } as unknown as NodeProps<ImageFlowNode>
  render(
    <ImageGenProvider
      projectId="p-1"
      nodes={nodesRef.current}
      nodesRef={nodesRef}
      assetsRef={{ current: undefined }}
      settings={{ characters: [] }}
      applyDataPatch={vi.fn()}
      addAsset={vi.fn()}
      removeAsset={vi.fn()}
      pushHistory={vi.fn()}
    >
      <NodeEditContext.Provider value={api}>
        <ImageNode {...props} />
      </NodeEditContext.Provider>
    </ImageGenProvider>,
  )
  return api
}

/** 外壳行为表（夹具取自各节点原测试文件；断言与原用例一一对应）。 */
const SHELLS: readonly NodeShellRow[] = [
  {
    // 源自 SceneNode.test.tsx「⚙️ 点击 toggleSettings；openSettingsId
    // 命中时展开设置面板」与「端口：左入、右出、底部 SCENE_SHOT_HANDLE
    // 分镜下挂口」。
    kind: 'SceneNode（索引卡）',
    id: 's1',
    settingsButton: '场景设置',
    expectOpen: () => {
      expect(screen.getByRole('combobox')).toBeTruthy() // 地点下拉
    },
    render: renderSceneShell,
    ports: ['target', 'source', `source-${SCENE_SHOT_HANDLE}`],
  },
  {
    // 源自 DialogueNode.test.tsx「⚙️ 点击 toggleSettings 且阻止冒泡；
    // openSettingsId 命中时展开设置面板」「名称双击内联改名 → patchNode
    // 合并 name」与「端口：左入右出」。
    kind: 'DialogueNode（气泡流卡）',
    id: 'd1',
    settingsButton: '对白设置',
    expectOpen: () => {
      expect(screen.getByRole('button', { name: '＋ 添加台词' })).toBeTruthy()
    },
    render: renderDialogueShell,
    rename: {
      button: '真相逼近',
      input: '对白名称',
      value: '雨夜摊牌',
      cmd: { nodeType: 'dialogue', patch: { name: '雨夜摊牌' } },
    },
    ports: ['target', 'source'],
  },
  {
    // 源自 BeatNode.test.tsx「⚙️ 点击 toggleSettings；名称双击改名 →
    // patchNode」（原单用例拆入开关与改名两组；该文件未覆盖展开态）。
    kind: 'BeatNode（节拍胶囊）',
    id: 'b1',
    settingsButton: '节奏卡设置',
    render: renderBeatShell,
    rename: {
      button: '真相逼近',
      input: '节奏卡内容',
      value: '雨夜反转',
      cmd: { nodeType: 'beat', patch: { name: '雨夜反转' } },
    },
  },
  {
    // 源自 BranchNode.test.tsx「⚙️ 点击 toggleSettings；openSettingsId
    // 命中时展开设置面板（含添加选项）」「问句双击内联改名 → patchNode
    // 合并 prompt」及渲染用例中的每选项独立出口端口断言。
    kind: 'BranchNode（岔路路标）',
    id: 'br1',
    settingsButton: '分支设置',
    expectOpen: () => {
      expect(screen.getByRole('button', { name: '＋ 添加选项' })).toBeTruthy()
    },
    render: renderBranchShell,
    rename: {
      button: '林晚是否发现真相？',
      input: '分支问句',
      value: '追或不追？',
      cmd: { nodeType: 'branch', patch: { prompt: '追或不追？' } },
    },
    ports: [
      'target',
      `source-${BRANCH_OPTION_HANDLE_PREFIX}o1`,
      `source-${BRANCH_OPTION_HANDLE_PREFIX}o2`,
    ],
  },
  {
    // 源自 ShotNode.test.tsx「⚙️ 点击 toggleSettings；openSettingsId
    // 命中时展开设置面板（含添加引用）」与「端口：顶部入口（宿主下挂）
    // + 右侧出口」（该文件未覆盖内联改名）。
    kind: 'ShotNode（监视器卡）',
    id: 'sh1',
    settingsButton: '分镜设置',
    expectOpen: () => {
      expect(screen.getByRole('button', { name: '＋ 添加引用' })).toBeTruthy()
    },
    render: renderShotShell,
    ports: ['target', 'source'],
  },
  {
    // 源自 ImageNode.test.tsx「⚙️ 展开设置面板（openSettingsId 命中时
    // 渲染 PROMPT 表单）」（原文件仅覆盖展开态，无点击与端口断言）。
    kind: 'ImageNode（图片节点）',
    id: 'img1',
    expectOpen: () => {
      expect(screen.getByLabelText('图片节点设置')).toBeTruthy()
      expect(screen.getByPlaceholderText(/角色定妆/)).toBeTruthy()
    },
    render: renderImageShell,
  },
]

describe('⚙️ 设置面板开关（节点外壳共享行为，issue #534）', () => {
  it.each(SHELLS)(
    '$kind：点击 toggleSettings 报告自身 id；openSettingsId 命中时展开设置面板',
    (shell) => {
      const api = shell.render(null)
      if (shell.settingsButton !== undefined) {
        fireEvent.click(
          screen.getByRole('button', { name: shell.settingsButton }),
        )
        expect(api.toggleSettings).toHaveBeenCalledWith(shell.id)
      }
      if (shell.expectOpen !== undefined) {
        cleanup()
        shell.render(shell.id)
        shell.expectOpen()
      }
    },
  )
})

const RENAME_CASES = SHELLS.flatMap((shell) =>
  shell.rename === undefined
    ? []
    : [
        {
          kind: shell.kind,
          id: shell.id,
          rename: shell.rename,
          render: shell.render,
        },
      ],
)

describe('双击内联改名 → patchNode（节点外壳共享行为，issue #534）', () => {
  it.each(RENAME_CASES)(
    '$kind：双击「$rename.button」改名，失焦经 patchNode 合并补丁',
    ({ id, rename, render }) => {
      const api = render(null)
      fireEvent.doubleClick(screen.getByRole('button', { name: rename.button }))
      const input = screen.getByRole('textbox', { name: rename.input })
      fireEvent.change(input, { target: { value: rename.value } })
      fireEvent.blur(input)
      expect(api.patchNode).toHaveBeenCalledWith(id, rename.cmd)
    },
  )
})

const PORT_CASES = SHELLS.flatMap((shell) =>
  shell.ports === undefined
    ? []
    : [{ kind: shell.kind, ports: shell.ports, render: shell.render }],
)

describe('端口锚点布局（节点外壳共享行为，issue #534）', () => {
  it.each(PORT_CASES)(
    '$kind：按锚点 testid 渲染全部端口',
    ({ ports, render }) => {
      render(null)
      for (const handle of ports) {
        expect(screen.getByTestId(`handle-${handle}`)).toBeTruthy()
      }
    },
  )
})
