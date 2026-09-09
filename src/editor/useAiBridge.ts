/**
 * AI 桥（docs/ui-design.md §6，数据模型 §12：Agent 是命令的另一个生产者）。
 * EditorView 拆出的 ✦AI 相关回调族：画布上下文快照（digest）、整批校验、
 * 读工具 get_node、改动落地 applyAiBatch。批量执行的折叠模拟见 ai/batchSim.ts；
 * 校验语义见 ai/commands.ts；快照压缩见 ai/graphDigest.ts。
 */
import { useCallback, useMemo } from 'react'
import type { Edge } from '@xyflow/react'
import { buildGraphDigest } from './ai/graphDigest'
import { extractBatchJson } from './ai/batchText'
import { graphSignature } from './graphSignature'
import { settingsSnapshotText } from './ai/entityFields'
import {
  toInboundCommands,
  validateAiBatch,
  type AiCommand,
  type AiGraphSnapshot,
  type BatchValidation,
  type ValidatedCommand,
} from './ai/commands'
import { simulateBatch, type BatchOps, type BuildNewNode } from './ai/batchSim'
import type { HistoryCommand } from './history'
import {
  resolveCharacterName,
  resolveLocationName,
  type ProjectSettings,
} from './settings'
import type { NodeDataPatch } from './nodes/patch'
import type { CanvasNode } from './nodes/types'
import type { ProjectContent } from '../model/content'

/** 节点人读标签：画布快照、改动预览与批次执行共用。 */
export function nodeLabelOf(n: CanvasNode): string {
  switch (n.type) {
    case 'scene': return `场${n.data.sceneNo}·${n.data.name}`
    case 'dialogue': return `对白·${n.data.name}`
    case 'beat': return `节拍·${n.data.name}`
    case 'branch': return `分支·${n.data.prompt}`
    case 'shot': return `SHOT${n.data.shotNo}·${n.data.size}`
    case 'image': return `图片·${n.data.prompt.slice(0, 12)}`
  }
}

/** AI 桥依赖：反应式画布用于 digest；ref 镜像供校验/读取/落地读取当前态。 */
export interface AiBridgeDeps {
  nodes: CanvasNode[]
  edges: Edge[]
  settings: ProjectSettings
  nodesRef: { current: CanvasNode[] }
  edgesRef: { current: Edge[] }
  /** 设定集镜像（issue 44）：实体校验快照与落地重校验消费「当前」设定集。 */
  settingsRef: { current: ProjectSettings }
  /** 项目资产索引镜像（会话内不编辑资产，透传桶的稳定引用）：
   * shot.refs 引用位的资产存在性/用途校验在快照里消费。 */
  assetsRef: { current: ProjectContent['assets'] }
  buildNewNode: BuildNewNode
  /** 纯状态写入（AI 更新命令的落地通道）：补丁按节点类型判别绑定（issue 16）。 */
  applyDataPatch: (id: string, cmd: NodeDataPatch) => void
  setNodes: (updater: (all: CanvasNode[]) => CanvasNode[]) => void
  setEdges: (updater: (eds: Edge[]) => Edge[]) => void
  /** 设定集功能式写入（issue 44）：实体改动的落地通道，与节点绑定同一复合命令。 */
  setSettings: (updater: (prev: ProjectSettings) => ProjectSettings) => void
  pushHistory: (cmd: HistoryCommand) => void
  closeSettings: () => void
}

/** ✦AI 桥回调族。 */
export interface AiBridge {
  /** 画布上下文快照（§6「了解当前画布」+ §12.2 压缩视图）。 */
  canvasDigest: string
  /** 画布语义内容签名（graphSignature）：AI 执行卡恢复对账判定批次是否已随画布落盘。 */
  canvasSignature: string
  /** 解析并整批校验助手回复里的命令；无批次（纯讨论）返回 null。 */
  validateAiReply: (text: string) => BatchValidation | null
  /** tool-calling 通道：工具调用映射出的命令数组走同一整批校验。 */
  validateCommands: (commands: AiCommand[]) => BatchValidation | null
  /** 读工具 get_node：返回节点完整字段 JSON；不存在返回 null。 */
  readNode: (nodeId: string) => string | null
  /** 读工具 get_settings_snapshot（issue 44）：返回设定集清单 JSON。 */
  readSettings: () => string
  /** ✦AI 改动落地：整批作为一条复合命令入栈；返回错误文案或 null。
   * 入参为整批校验通过的执行命令（预览卡的合法子集，issue 16）。 */
  applyAiBatch: (batch: ValidatedCommand[]) => string | null
}

/** AI 校验用的图快照装配（§12.2）：类型 + 分支选项（id）供分类型校验与
 * 端口解析；资产索引（id → MIME）供 shot.refs 引用位的存在性/用途校验；
 * 设定集压缩视图（issue 44）供实体存在性与引用类型校验。 */
function graphSnapshotOf(
  nodesRef: { current: CanvasNode[] },
  edgesRef: { current: Edge[] },
  settingsRef: { current: ProjectSettings },
  assetsRef: { current: ProjectContent['assets'] },
): AiGraphSnapshot {
  return {
    nodes: nodesRef.current.map((n) => ({
      id: n.id,
      type: n.type,
      label: nodeLabelOf(n),
      ...(n.type === 'branch' ? { options: n.data.options.map((o) => ({ id: o.id, label: o.label })) } : {}),
    })),
    edges: edgesRef.current.map((e) => ({
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle,
      type: e.type,
    })),
    // Map 精确匹配避免普通对象键的原型链误命中（如 assetId "constructor"）
    assets: new Map(
      Object.entries(assetsRef.current?.byId ?? {}).map(([id, a]) => [id, a.mime]),
    ),
    settings: {
      characters: settingsRef.current.characters.map(({ id, name }) => ({ id, name })),
      locations: settingsRef.current.locations.map(({ id, name }) => ({ id, name })),
    },
  }
}

/** ✦AI 改动落地的编排内核（useAiBridge 拆出，issue 16）：先按当前图重新
 * 整批校验（防预览后用户又改了画布/设定集；入站形态重校验见
 * toInboundCommands），折叠模拟产出前进/回退闭包，整体作为一条复合命令
 * 入栈——执行整批生效，⌘Z 一步撤销即整批回滚（实体与绑定两侧同时恢复，
 * issue 44）。返回错误文案或 null。 */
function applyValidatedBatch(
  batch: ValidatedCommand[],
  ctx: {
    snapshot: () => AiGraphSnapshot
    ops: BatchOps
    nodesRef: { current: CanvasNode[] }
    edgesRef: { current: Edge[] }
    settingsRef: { current: ProjectSettings }
    pushHistory: (cmd: HistoryCommand) => void
    closeSettings: () => void
  },
): string | null {
  if (batch.length === 0) return null
  const fresh = validateAiBatch(toInboundCommands(batch), ctx.snapshot())
  if (!fresh.ok) {
    return `改动无法安全执行：${fresh.issues[0]?.message ?? '批次校验未通过'}`
  }
  const sim = simulateBatch(
    fresh.commands,
    ctx.ops,
    ctx.nodesRef.current,
    ctx.edgesRef.current,
    ctx.settingsRef.current,
  )
  sim.forward.forEach((f) => f())
  ctx.pushHistory({
    undo: () => [...sim.backward].reverse().forEach((f) => f()),
    redo: () => sim.forward.forEach((f) => f()),
  })
  ctx.closeSettings()
  return null
}

/** 校验与读工具族（useAiBridge 拆出的回调子域）：反应式画布 → 快照 digest；
 * ref 镜像 → 整批校验快照与 get_node / get_settings_snapshot 读工具。
 * aiSnapshot 一并回传供落地重校验复用。 */
function useAiReadTools(deps: {
  nodes: CanvasNode[]
  edges: Edge[]
  settings: ProjectSettings
  nodesRef: { current: CanvasNode[] }
  edgesRef: { current: Edge[] }
  settingsRef: { current: ProjectSettings }
  assetsRef: { current: ProjectContent['assets'] }
}) {
  const { nodes, edges, settings, nodesRef, edgesRef, settingsRef, assetsRef } = deps

  const canvasDigest = useMemo(
    () =>
      buildGraphDigest(nodes, edges, {
        characters: settings.characters,
        locations: settings.locations,
        characterName: (id) => resolveCharacterName(settings, id),
        locationName: (id) => resolveLocationName(settings, id),
      }),
    [nodes, edges, settings],
  )

  /** 语义签名与 digest 同源（同一渲染的画布状态）：执行卡恢复对账消费。 */
  const canvasSignature = useMemo(() => graphSignature(nodes, edges, settings), [nodes, edges, settings])

  /** AI 校验用的图快照（§12.2）：装配见 graphSnapshotOf。 */
  const aiSnapshot = useCallback(
    () => graphSnapshotOf(nodesRef, edgesRef, settingsRef, assetsRef),
    [nodesRef, edgesRef, settingsRef, assetsRef],
  )

  const validateAiReply = useCallback(
    (text: string): BatchValidation | null => {
      const parsed = extractBatchJson(text)
      if (!parsed) return null
      return validateAiBatch(parsed.commands, aiSnapshot())
    },
    [aiSnapshot],
  )

  const validateCommands = useCallback(
    (commands: AiCommand[]): BatchValidation | null => validateAiBatch(commands, aiSnapshot()),
    [aiSnapshot],
  )

  const readNode = useCallback(
    (nodeId: string): string | null => {
      const n = nodesRef.current.find((x) => x.id === nodeId)
      return n ? JSON.stringify({ id: n.id, type: n.type, data: n.data }) : null
    },
    [nodesRef],
  )

  /** 读工具 get_settings_snapshot（issue 44）：清单文本由 entityFields 单点生成。 */
  const readSettings = useCallback(
    (): string => settingsSnapshotText(settingsRef.current),
    [settingsRef],
  )

  return { canvasDigest, canvasSignature, aiSnapshot, validateAiReply, validateCommands, readNode, readSettings }
}

export function useAiBridge(deps: AiBridgeDeps): AiBridge {
  const {
    nodesRef,
    edgesRef,
    settingsRef,
    buildNewNode,
    applyDataPatch,
    setNodes,
    setEdges,
    setSettings,
    pushHistory,
    closeSettings,
  } = deps
  const { canvasDigest, canvasSignature, aiSnapshot, validateAiReply, validateCommands, readNode, readSettings } =
    useAiReadTools(deps)

  /** ✦AI 改动落地：整批作为一条复合命令入栈；返回错误文案或 null。
   * 入参为整批校验通过的执行命令（预览卡的合法子集，issue 16）；
   * 重校验与入栈编排见 applyValidatedBatch。 */
  const applyAiBatch = useCallback(
    (batch: ValidatedCommand[]): string | null =>
      applyValidatedBatch(batch, {
        snapshot: aiSnapshot,
        ops: { buildNewNode, applyDataPatch, setNodes, setEdges, setSettings },
        nodesRef,
        edgesRef,
        settingsRef,
        pushHistory,
        closeSettings,
      }),
    [aiSnapshot, applyDataPatch, buildNewNode, closeSettings, edgesRef, nodesRef, pushHistory, setEdges, setNodes, setSettings, settingsRef],
  )

  return { canvasDigest, canvasSignature, validateAiReply, validateCommands, readNode, readSettings, applyAiBatch }
}
