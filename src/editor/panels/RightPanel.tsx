import type { ComponentProps } from 'react'
import { SegmentedControl } from './SegmentedControl'
import { PanelResizer } from './PanelResizer'
import {
  type BatchValidation,
  type AiCommand,
  type ValidatedCommand,
} from '../ai/commands'
import { type ProjectSettings } from '../settings'
import { resolveCharacterName, resolveLocationName } from '../settings'
import { AiThread, AiSettingsButton } from './AiThread'
import type { AiCommitIdentity } from '../ai/commitIdentity'
import type { CanvasNode } from '../nodes/types'
import type { AiSession } from '../ai/session'

/** 右栏分段（docs/ui-design.md §3.4）：检查器 = 选中节点的字段视图；✦AI = 对话面板。 */
export type RightTab = 'inspector' | 'ai'

const TABS = [
  { value: 'inspector' as const, label: '检查器' },
  { value: 'ai' as const, label: '✦ AI' },
]

const TYPE_LABELS: Record<CanvasNode['type'], string> = {
  scene: '场景 · 索引卡',
  dialogue: '对白 · 气泡流',
  beat: '节奏卡 · 节拍胶囊',
  branch: '分支 · 岔路路标',
  shot: '分镜卡 · 监视器卡',
  image: '图片节点 · 生成产物',
}

/** 场景节点检查器行（inspectorRows 拆分，issue #99）。 */
function sceneInspectorRows(
  node: Extract<CanvasNode, { type: 'scene' }>,
  shotCount: number,
  settings: ProjectSettings,
): { label: string; value: string }[] {
  const locationName = node.data.locationId
    ? resolveLocationName(settings, node.data.locationId)
    : null
  return [
    { label: '名称', value: node.data.name },
    {
      label: '场号',
      value: `SCENE ${String(node.data.sceneNo).padStart(2, '0')}`,
    },
    { label: '内外景', value: node.data.interior ? '内' : '外' },
    {
      label: '地点',
      value: locationName ?? (node.data.locationId ? '（已删除）' : '未指定'),
    },
    { label: '时间', value: node.data.time },
    ...(node.data.weather ? [{ label: '天气', value: node.data.weather }] : []),
    { label: '分镜', value: `🎞 ${shotCount} 镜` },
    { label: '梗概', value: node.data.synopsis },
    {
      label: '在场角色',
      value:
        node.data.characterIds
          .map((id) => resolveCharacterName(settings, id) ?? '（已删除）')
          .join(' / ') || '—',
    },
  ]
}

/** 对白节点检查器行（inspectorRows 拆分，issue #99）。 */
function dialogueInspectorRows(
  node: Extract<CanvasNode, { type: 'dialogue' }>,
  settings: ProjectSettings,
): { label: string; value: string }[] {
  const speakers = new Set(
    node.data.lines.flatMap((l) =>
      l.kind === 'line' && l.speaker
        ? [resolveCharacterName(settings, l.speaker) ?? '（已删除）']
        : [],
    ),
  )
  const actions = node.data.lines.filter((l) => l.kind === 'action').length
  return [
    { label: '名称', value: node.data.name },
    { label: '人物', value: [...speakers].join(' / ') },
    { label: '台词', value: `${node.data.lines.length - actions} 句` },
    { label: '动作行', value: `${actions} 行` },
  ]
}

/** 检查器字段行：按节点类型派生只读视图（编辑随后续 ⚙️ 设置面板任务落地）。 */
function inspectorRows(
  node: CanvasNode,
  shotCount: number,
  settings: ProjectSettings,
): { label: string; value: string }[] {
  switch (node.type) {
    case 'scene':
      return sceneInspectorRows(node, shotCount, settings)
    case 'dialogue':
      return dialogueInspectorRows(node, settings)
    case 'beat':
      return [
        { label: '名称', value: node.data.name },
        { label: '基调', value: node.data.tone },
      ]
    case 'branch':
      return [
        { label: '问句', value: node.data.prompt },
        {
          label: '选项',
          value: node.data.options.map((o) => o.label).join(' / '),
        },
      ]
    case 'shot':
      return [
        {
          label: '镜号',
          value: `SHOT ${String(node.data.shotNo).padStart(2, '0')}`,
        },
        { label: '景别', value: node.data.size },
        { label: '画面描述', value: node.data.picture },
        { label: '镜头 PROMPT', value: node.data.prompt },
        {
          label: '引用',
          value: node.data.refs.map((r) => r.label).join(' / ') || '—',
        },
      ]
    case 'image':
      return [
        { label: 'PROMPT', value: node.data.prompt },
        { label: '模型', value: node.data.model || '未选择' },
        { label: '尺寸', value: node.data.size },
      ]
  }
}

type RightAiPaneProps = Pick<
  RightPanelProps,
  | 'tab'
  | 'projectId'
  | 'onOpenSettings'
  | 'canvasDigest'
  | 'commitIdentity'
  | 'onValidateAi'
  | 'onValidateCommands'
  | 'onReadNode'
  | 'onReadSettings'
  | 'onReadDocument'
  | 'onApplyAiBatch'
  | 'aiSession'
  | 'aiSessionError'
  | 'aiSessionRetryable'
  | 'onSaveAiSession'
  | 'aiSessionLoadFailed'
>

/** 右栏 AI 分段（RightPanel 拆分，issue #99）：常驻挂载（hidden 切换不
 * 卸载会话容器，issue 58），props 自面板契约透传。 */
function RightAiPane(props: RightAiPaneProps) {
  return (
    <AiPane
      hidden={props.tab !== 'ai'}
      loadFailed={props.aiSessionLoadFailed}
      projectId={props.projectId}
      onOpenSettings={props.onOpenSettings}
      canvasDigest={props.canvasDigest}
      commitIdentity={props.commitIdentity}
      onValidateAi={props.onValidateAi}
      onValidateCommands={props.onValidateCommands}
      onReadNode={props.onReadNode}
      onReadSettings={props.onReadSettings}
      onReadDocument={props.onReadDocument}
      onApplyAiBatch={props.onApplyAiBatch}
      initialSession={props.aiSession}
      initialSessionError={props.aiSessionError}
      initialSessionRetryable={props.aiSessionRetryable}
      onSaveSession={props.onSaveAiSession}
    />
  )
}

/** 检查器内容（RightPanel 拆分，issue #99）：选中节点时列字段行，
 * 否则空态引导。 */
function InspectorBody({
  selectedNode,
  rows,
}: {
  readonly selectedNode: CanvasNode
  readonly rows: { label: string; value: string }[]
}) {
  return (
    <div className="pw-inspector">
      <div className="pw-inspector-type">{TYPE_LABELS[selectedNode.type]}</div>
      {rows.map((row) => (
        <div key={row.label} className="pw-inspector-row">
          <span className="pw-inspector-label">{row.label}</span>
          <span className="pw-inspector-value">{row.value}</span>
        </div>
      ))}
    </div>
  )
}

/** 加载失败时只显示诊断，聊天操作区不挂载，避免空回退产生写入。设置
 * 入口不是聊天操作区（无会话写入），失败态照常保留（issue #87）——
 * 否则会话损坏的用户只剩不可见的 ⌘, 可进设置页。 */
function AiSessionContent({
  loadFailed,
  ...props
}: ComponentProps<typeof AiThread> & {
  // 可显式 undefined = 会话读取未失败（issue #231）
  readonly loadFailed?: boolean | undefined
}) {
  if (loadFailed) {
    return (
      <>
        <p className="pw-ai-error" role="alert">
          聊天记录读取失败，AI 发送和执行已停用。请检查磁盘后重新打开项目。
          {props.initialSessionError}
        </p>
        <div className="pw-ai-error-actions">
          <AiSettingsButton onOpenSettings={props.onOpenSettings} />
        </div>
      </>
    )
  }
  return <AiThread {...props} />
}

interface RightPanelProps {
  readonly open: boolean
  readonly width: number
  readonly onResize: (width: number) => void
  readonly tab: RightTab
  readonly onTabChange: (tab: RightTab) => void
  /** 项目 id：AI 在途回合跨卸载归属的键（issue #63，见 ai/pendingTurns）。 */
  readonly projectId: string
  /** 画布当前选中节点；无选中时检查器显示空态。 */
  // 可显式 undefined = 无选中（issue #231）
  readonly selectedNode?: CanvasNode | undefined
  /** 选中索引卡的 attach 下挂分镜数（§7.2 派生，检查器展示用）。 */
  readonly attachedShotCount?: number
  /** 项目设定集：检查器解析实体引用（§5）。 */
  readonly settings: ProjectSettings
  /** 打开设置页（§8.2 BYOK 配置入口）。 */
  // 可显式 undefined = 未接线（issue #231）
  readonly onOpenSettings?: (() => void) | undefined
  /** 画布上下文快照（§6「了解当前画布」）：附到 system prompt，并作为读工具返回。 */
  readonly canvasDigest?: string
  /** AI 执行卡的提交身份（§12.2 / issue #139）：批次计数必带、画布确认
   * 等待器可选（嵌套形状禁止「有等待器无计数」的误配）；省略 = 隔离装配。 */
  readonly commitIdentity?: AiCommitIdentity
  /** 校验助手回复中的命令批次（§6/数据模型 §12）；纯讨论回复返回 null。 */
  readonly onValidateAi?: (text: string) => BatchValidation | null
  /** 校验工具调用映射出的命令数组（tool-calling 通道）。 */
  readonly onValidateCommands?: (
    commands: AiCommand[],
  ) => BatchValidation | null
  /** 读工具 get_node：返回节点 JSON 文本，节点不存在返回 null。 */
  readonly onReadNode?: (nodeId: string) => string | null
  /** 读工具 get_settings_snapshot（issue 44）：返回设定集清单 JSON 文本。 */
  readonly onReadSettings?: () => string
  /** 读工具 get_document（issue 56）：按 id 返回文档全文 JSON，不存在返回 null。 */
  readonly onReadDocument?: (documentId: string) => string | null
  /** 执行已确认的批次：整批为一条复合命令入栈，返回错误文案或 null。 */
  readonly onApplyAiBatch?: (commands: ValidatedCommand[]) => string | null
  /** 当前项目恢复的 AI 会话与其独立保存通道。 */
  // 可显式 undefined = 无恢复快照（issue #231）
  readonly aiSession?: AiSession | undefined
  readonly aiSessionError?: string | null
  /** 会话读取失败时阻止 AI 发送和执行，画布仍可使用。 */
  // 可显式 undefined = 会话读取未失败（issue #231）
  readonly aiSessionLoadFailed?: boolean | undefined
  /** 内存会话可否作为挂载重试的落盘内容；读取失败（空回退）时为 false。 */
  readonly aiSessionRetryable?: boolean
  readonly onSaveAiSession?: (session: AiSession) => Promise<void>
}

/**
 * 编辑器右栏（docs/ui-design.md §3.4/§6）：
 * 「检查器 / ✦AI」分段。检查器展示选中节点的派生字段（只读），
 * ✦AI 会话支持改动预览卡——Agent 产出的命令批次经整批校验后
 * 由用户确认执行（删除类二次确认），整批一步撤销（数据模型 §12）。
 * 会话容器在 AiThread.tsx、预览卡在 PreviewCard.tsx、会话模型在
 * aiThreadModel.ts（issue #39 拆分），本文件保留检查器域与编排。
 */
/** ✦AI 分段主体（自 RightPanel 拆出，PR #83 评审：函数行数上限）：
 * 常驻挂载包裹层（§3.4）——pw-ai-pane 承接 .pw-panel-scroll → .pw-ai 的
 * 高度链（panels.css），hidden 由该类显式压回 display:none（issue 58），
 * 切换分段不卸载会话容器。 */
function AiPane({
  hidden,
  ...thread
}: ComponentProps<typeof AiThread> & {
  // 可显式 undefined = 会话读取未失败（issue #231）
  readonly loadFailed?: boolean | undefined
  readonly hidden: boolean
}) {
  return (
    <div className="pw-ai-pane" hidden={hidden}>
      <AiSessionContent {...thread} />
    </div>
  )
}

/** 右侧面板（§3.4：检查器 / ✦AI 分段）：检查器显示选中节点的只读摘要，
 * AI 页承载会话；宽度经 PanelResizer 调整。 */
export function RightPanel(props: RightPanelProps) {
  const selectedNode = props.selectedNode
  const rows = selectedNode
    ? inspectorRows(selectedNode, props.attachedShotCount ?? 0, props.settings)
    : []

  return (
    <aside
      className={`pw-panel pw-panel-right${props.open ? '' : ' pw-panel-closed'}`}
      style={{ width: props.open ? props.width : 0 }}
      aria-label="检查器"
      aria-hidden={!props.open}
    >
      {props.open && (
        <PanelResizer
          direction={-1}
          startWidth={props.width}
          onResize={props.onResize}
        />
      )}
      <div className="pw-panel-inner" style={{ width: props.width }}>
        <div className="pw-panel-head">
          <SegmentedControl
            groupLabel="右栏分段"
            options={TABS}
            value={props.tab}
            onChange={props.onTabChange}
          />
        </div>
        <div className="pw-panel-scroll">
          {props.tab === 'inspector' &&
            (selectedNode ? (
              <InspectorBody selectedNode={selectedNode} rows={rows} />
            ) : (
              <div className="pw-empty">
                在画布中选择一个节点，查看它的字段。
              </div>
            ))}
          {/* 常驻挂载语义见 AiPane（issue 58）：hidden 切换不卸载会话容器 */}
          <RightAiPane {...props} />
        </div>
      </div>
    </aside>
  )
}
