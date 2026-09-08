/**
 * 连线校验与建立（EditorView 拆出的连线写域，docs/ui-design.md §4.3/§4.4）：
 * 拖动时的实时校验（自环 / 成环 / 重复边 / 端点类型越界为非法，attach 下挂
 * 一对多合法且宿主唯一），以及落线入栈。判定语义与 AI 批量校验共用
 * graphRules 纯函数——交互侧放行一条「下次加载即被静默删除」的连线是坏体验。
 */
import { useCallback } from 'react'
import { addEdge, type Connection, type Edge } from '@xyflow/react'
import {
  BRANCH_OPTION_HANDLE_PREFIX,
  SCENE_SHOT_HANDLE,
  connectEdgeExtras,
  connectionEndpointIssue,
  connectionKindOf,
  hasAttachHost,
  isDuplicateEdge,
  wouldCreateCycle,
} from './graphRules'
import type { EditorDocument } from './useEditorDocument'
import type { HistoryCommand } from './history'

/** 连线校验与建立入口，供 ReactFlow 的 isValidConnection / onConnect 直接消费。 */
export interface ConnectionRules {
  /** 实时校验（拖动中的预览态）：true = 允许落线。 */
  isValidConnection: (conn: Connection | Edge) => boolean
  /** 落线：建成 sequence/branch/attach 边并单步入栈可撤销。 */
  onConnect: (connection: Connection) => void
}

/** 以文档状态镜像实现连线规则；attach 是垂直派生边，不参与剧情流环检测。 */
export function useConnectionRules(
  doc: EditorDocument,
  pushHistory: (cmd: HistoryCommand) => void,
): ConnectionRules {
  const { nodesRef, edgesRef, setEdges } = doc

  const isValidConnection = useCallback(
    (conn: Connection | Edge): boolean => {
      if (conn.source === conn.target) return false
      const existing = edgesRef.current
      if (isDuplicateEdge(existing, conn)) return false
      const nodeTypeOf = (id: string) => nodesRef.current.find((n) => n.id === id)?.type
      if (conn.sourceHandle === SCENE_SHOT_HANDLE) {
        const issue = connectionEndpointIssue(
          nodeTypeOf(conn.source),
          nodeTypeOf(conn.target),
          'attach',
        )
        if (issue !== null) return false
        // 宿主唯一（§5）：已有宿主的分镜不接受第二条下挂——换宿主须先断开
        return !hasAttachHost(existing, conn.target)
      }
      const flowEdges = existing.filter((e) => e.sourceHandle !== SCENE_SHOT_HANDLE)
      if (wouldCreateCycle(flowEdges, conn.source, conn.target)) return false
      // Connection 无 type/className，语义从端口推出（选项出口 = branch），
      // 误归 sequence 会被「分支不得以 sequence 连出」拒绝而拖不出连线
      const kind = connectionKindOf(conn)
      return connectionEndpointIssue(nodeTypeOf(conn.source), nodeTypeOf(conn.target), kind) === null
    },
    [edgesRef, nodesRef],
  )

  const onConnect = useCallback(
    (connection: Connection) => {
      const fromBranchOption =
        connection.sourceHandle?.startsWith(BRANCH_OPTION_HANDLE_PREFIX) ?? false
      const fromShotHandle = connection.sourceHandle === SCENE_SHOT_HANDLE
      const edge: Edge = {
        ...connection,
        id: `e-${connection.source}-${connection.sourceHandle ?? 'out'}-${connection.target}`,
        ...connectEdgeExtras(fromBranchOption, fromShotHandle),
      }
      setEdges((eds) => addEdge(edge, eds))
      pushHistory({
        undo: () => setEdges((eds) => eds.filter((e) => e.id !== edge.id)),
        redo: () => setEdges((eds) => addEdge(edge, eds)),
      })
    },
    [pushHistory, setEdges],
  )

  return { isValidConnection, onConnect }
}
