/**
 * AI 桥（docs/ui-design.md §6，数据模型 §12：Agent 是命令的另一个生产者）。
 * EditorView 拆出的 ✦AI 相关回调族：画布上下文快照（digest）、整批校验、
 * 读工具 get_node、改动落地 applyAiBatch。批量执行的折叠模拟见 ai/batchSim.ts；
 * 校验语义见 ai/commands.ts；快照压缩见 ai/graphDigest.ts。
 */
import { useCallback, useMemo } from 'react'
import type { Edge } from '@xyflow/react'
import { buildGraphDigest } from './ai/graphDigest'
import {
  extractBatchJson,
  validateAiBatch,
  type AiCommand,
  type AiGraphSnapshot,
  type BatchValidation,
} from './ai/commands'
import { simulateBatch, type BuildNewNode } from './ai/batchSim'
import type { HistoryCommand } from './history'
import {
  resolveCharacterName,
  resolveLocationName,
  type ProjectSettings,
} from './settings'
import type { CanvasNode } from './nodes/types'

/** 节点人读标签：画布快照、改动预览与批次执行共用。 */
export function nodeLabelOf(n: CanvasNode): string {
  switch (n.type) {
    case 'scene': return `场${n.data.sceneNo}·${n.data.name}`
    case 'dialogue': return `对白·${n.data.name}`
    case 'beat': return `节拍·${n.data.name}`
    case 'branch': return `分支·${n.data.prompt}`
    case 'shot': return `SHOT${n.data.shotNo}·${n.data.size}`
  }
}

/** AI 桥依赖：反应式画布用于 digest；ref 镜像供校验/读取/落地读取当前态。 */
export interface AiBridgeDeps {
  nodes: CanvasNode[]
  edges: Edge[]
  settings: ProjectSettings
  nodesRef: { current: CanvasNode[] }
  edgesRef: { current: Edge[] }
  buildNewNode: BuildNewNode
  applyDataPatch: (id: string, patch: Record<string, unknown>) => void
  setNodes: (updater: (all: CanvasNode[]) => CanvasNode[]) => void
  setEdges: (updater: (eds: Edge[]) => Edge[]) => void
  pushHistory: (cmd: HistoryCommand) => void
  closeSettings: () => void
}

/** ✦AI 桥回调族。 */
export interface AiBridge {
  /** 画布上下文快照（§6「了解当前画布」+ §12.2 压缩视图）。 */
  canvasDigest: string
  /** 解析并整批校验助手回复里的命令；无批次（纯讨论）返回 null。 */
  validateAiReply: (text: string) => BatchValidation | null
  /** tool-calling 通道：工具调用映射出的命令数组走同一整批校验。 */
  validateCommands: (commands: AiCommand[]) => BatchValidation | null
  /** 读工具 get_node：返回节点完整字段 JSON；不存在返回 null。 */
  readNode: (nodeId: string) => string | null
  /** ✦AI 改动落地：整批作为一条复合命令入栈；返回错误文案或 null。 */
  applyAiBatch: (batch: AiCommand[]) => string | null
}

export function useAiBridge(deps: AiBridgeDeps): AiBridge {
  const {
    nodes,
    edges,
    settings,
    nodesRef,
    edgesRef,
    buildNewNode,
    applyDataPatch,
    setNodes,
    setEdges,
    pushHistory,
    closeSettings,
  } = deps

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

  /** AI 校验用的图快照（§12.2）：类型 + 分支选项数供分类型校验。 */
  const aiSnapshot = useCallback(
    (): AiGraphSnapshot => ({
      nodes: nodesRef.current.map((n) => ({
        id: n.id,
        type: n.type,
        label: nodeLabelOf(n),
        ...(n.type === 'branch' ? { optionsCount: n.data.options.length } : {}),
      })),
      edges: edgesRef.current.map((e) => ({
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle,
        type: e.type,
      })),
    }),
    [nodesRef, edgesRef],
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

  /** 改动落地：先按当前图重新整批校验（防预览后用户又改了画布），
   * 折叠模拟产出前进/回退闭包，整体作为一条复合命令入栈——
   * 执行整批生效，⌘Z 一步撤销即整批回滚。 */
  const applyAiBatch = useCallback(
    (batch: AiCommand[]): string | null => {
      if (batch.length === 0) return null
      const fresh = validateAiBatch(batch, aiSnapshot())
      if (!fresh.ok) {
        return `改动无法安全执行：${fresh.issues[0]?.message ?? '批次校验未通过'}`
      }
      const sim = simulateBatch(
        batch,
        { buildNewNode, applyDataPatch, setNodes, setEdges },
        nodesRef.current,
        edgesRef.current,
      )
      sim.forward.forEach((f) => f())
      pushHistory({
        undo: () => [...sim.backward].reverse().forEach((f) => f()),
        redo: () => sim.forward.forEach((f) => f()),
      })
      closeSettings()
      return null
    },
    [aiSnapshot, applyDataPatch, buildNewNode, closeSettings, edgesRef, nodesRef, pushHistory, setEdges, setNodes],
  )

  return { canvasDigest, validateAiReply, validateCommands, readNode, applyAiBatch }
}
