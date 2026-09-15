import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react'
import {
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
} from '@xyflow/react'
import {
  SCENE_SHOT_HANDLE,
  connectEdgeExtras,
  connectionEndpointIssue,
  connectionKindOf,
  hasAttachHost,
  isDuplicateEdge,
  wouldCreateCycle,
} from '../editor/graphRules'
import { mergeNodeData, type NodeDataPatch } from '../editor/nodes/patch'
import { beatFulfillmentMap } from '../editor/outline'
import type { NodeEditApi } from '../editor/nodeEdit'
import type { CanvasNode } from '../editor/nodes/types'
import { uid } from '../uid'
import { demoGraph } from './demoGraph'

/**
 * P1 画布演示页的本地编辑会话（docs/swiftui-react-flow-migration-plan.md
 * §5 第 3 项）：复用生产连线规则（graphRules 纯函数）与节点编辑上下文
 * （NodeEditApi），但全部状态只活在内存——无历史栈、无持久化、无 AI。
 * 交互语义（自环/成环/重复边/端点越界/attach 宿主唯一）与
 * useConnectionRules 保持同一套判定。
 */

/** 演示页编辑器装配：ReactFlow 输入 + NodeEditApi 上下文值。 */
export interface DemoEditor {
  readonly nodes: CanvasNode[]
  readonly edges: Edge[]
  readonly onNodesChange: ReturnType<typeof useNodesState<CanvasNode>>[2]
  readonly onEdgesChange: ReturnType<typeof useEdgesState<Edge>>[2]
  readonly isValidConnection: (conn: Connection | Edge) => boolean
  readonly onConnect: (connection: Connection) => void
  readonly nodeEditApi: NodeEditApi
}

/** 演示图唯一状态与回调读取镜像，供各编辑职责共用。 */
function useDemoGraphState() {
  const initial = useMemo(demoGraph, [])
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>(
    initial.nodes,
  )
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges)

  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)
  useEffect(() => {
    nodesRef.current = nodes
  }, [nodes])
  useEffect(() => {
    edgesRef.current = edges
  }, [edges])

  return {
    initial,
    nodes,
    setNodes,
    onNodesChange,
    edges,
    setEdges,
    onEdgesChange,
    nodesRef,
    edgesRef,
  }
}

/** 图状态模块的内部输入契约，不对外创建第二份图。 */
type DemoGraphState = ReturnType<typeof useDemoGraphState>

/** 实时连线规则与内存落线动作；复用既有 graphRules。 */
function useDemoConnections({ nodesRef, edgesRef, setEdges }: DemoGraphState) {
  const isValidConnection = useCallback(
    (conn: Connection | Edge): boolean => {
      if (conn.source === conn.target) return false
      const existing = edgesRef.current
      if (isDuplicateEdge(existing, conn)) return false
      const nodeTypeOf = (id: string) =>
        nodesRef.current.find((n) => n.id === id)?.type
      if (conn.sourceHandle === SCENE_SHOT_HANDLE) {
        const issue = connectionEndpointIssue(
          nodeTypeOf(conn.source),
          nodeTypeOf(conn.target),
          'attach',
        )
        return issue === null && !hasAttachHost(existing, conn.target)
      }
      const flowEdges = existing.filter(
        (e) => e.sourceHandle !== SCENE_SHOT_HANDLE,
      )
      if (wouldCreateCycle(flowEdges, conn.source, conn.target)) return false
      return (
        connectionEndpointIssue(
          nodeTypeOf(conn.source),
          nodeTypeOf(conn.target),
          connectionKindOf(conn),
        ) === null
      )
    },
    [nodesRef, edgesRef],
  )

  const onConnect = useCallback(
    (connection: Connection) => {
      const fromShotHandle = connection.sourceHandle === SCENE_SHOT_HANDLE
      const edge: Edge = {
        ...connection,
        id: `e-${connection.source}-${connection.sourceHandle ?? 'out'}-${connection.target}`,
        ...connectEdgeExtras(
          connection.sourceHandle?.startsWith('option-') ?? false,
          fromShotHandle,
        ),
      }
      setEdges((eds) => addEdge(edge, eds))
    },
    [setEdges],
  )

  return { isValidConnection, onConnect }
}

/** 节点字段、复制与删除动作；删除同时清理连线和目标设置面板。 */
function useDemoNodeActions(
  { nodesRef, setNodes, setEdges }: DemoGraphState,
  setOpenSettingsId: Dispatch<SetStateAction<string | null>>,
) {
  const patchNode = useCallback(
    (id: string, cmd: NodeDataPatch) => {
      setNodes((ns) =>
        ns.map((n) => (n.id === id ? mergeNodeData(n, cmd.patch) : n)),
      )
    },
    [setNodes],
  )

  const duplicateNode = useCallback(
    (id: string) => {
      const src = nodesRef.current.find((n) => n.id === id)
      if (!src) return
      const copy = {
        ...src,
        id: uid('demo'),
        position: { x: src.position.x + 32, y: src.position.y + 32 },
        selected: true,
        data: { ...src.data },
      } as CanvasNode
      setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), copy])
    },
    [nodesRef, setNodes],
  )

  const deleteNode = useCallback(
    (id: string) => {
      setNodes((ns) => ns.filter((n) => n.id !== id))
      setEdges((es) => es.filter((e) => e.source !== id && e.target !== id))
      setOpenSettingsId((cur) => (cur === id ? null : cur))
    },
    [setEdges, setNodes, setOpenSettingsId],
  )

  return { patchNode, duplicateNode, deleteNode }
}

/** 从最新图派生分镜计数与节拍兑现，避免存储镜像字段。 */
function useDemoCounts({ nodesRef, edgesRef }: DemoGraphState) {
  const shotCountOf = useCallback(
    (id: string) =>
      edgesRef.current.filter(
        (e) => e.source === id && e.sourceHandle === SCENE_SHOT_HANDLE,
      ).length,
    [edgesRef],
  )

  const beatFulfillmentOf = useCallback(
    (id: string) => {
      const isBeat = nodesRef.current.find((n) => n.id === id)?.type === 'beat'
      if (!isBeat) return null
      return (
        beatFulfillmentMap(nodesRef.current, edgesRef.current).get(id) ?? null
      )
    },
    [nodesRef, edgesRef],
  )

  return { shotCountOf, beatFulfillmentOf }
}

/** 装配图、连线和节点能力；P1 会话仅存在于内存。 */
export function useDemoEditor(): DemoEditor {
  const graph = useDemoGraphState()
  const { initial, nodes, edges, onNodesChange, onEdgesChange } = graph
  const [openSettingsId, setOpenSettingsId] = useState<string | null>(null)
  const { isValidConnection, onConnect } = useDemoConnections(graph)
  const { patchNode, duplicateNode, deleteNode } = useDemoNodeActions(
    graph,
    setOpenSettingsId,
  )
  const { shotCountOf, beatFulfillmentOf } = useDemoCounts(graph)
  const toggleSettings = useCallback((id: string) => {
    setOpenSettingsId((cur) => (cur === id ? null : id))
  }, [])
  const closeSettings = useCallback(() => setOpenSettingsId(null), [])

  const nodeEditApi = useMemo<NodeEditApi>(
    () => ({
      projectId: 'demo-fixture',
      openSettingsId,
      toggleSettings,
      closeSettings,
      patchNode,
      duplicateNode,
      deleteNode,
      shotCountOf,
      beatFulfillmentOf,
      settings: initial.settings,
      assets: { byId: {} },
    }),
    [
      initial.settings,
      openSettingsId,
      patchNode,
      duplicateNode,
      deleteNode,
      shotCountOf,
      beatFulfillmentOf,
      toggleSettings,
      closeSettings,
    ],
  )

  return {
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    isValidConnection,
    onConnect,
    nodeEditApi,
  }
}
