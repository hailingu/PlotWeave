/**
 * 会话类型 ⇄ 编辑器运行态的结构兼容探针（issue #353 方向一）：仅由严格
 * 类型检查入口编译（tsconfig.strict.json——主构建与测试排除
 * *.test-d.ts）。会话文档的节点/边类型由 src/model/ 所有后，编辑器
 * CanvasNode / React Flow Edge 必须与 model/session 的最小结构双向可赋值
 * ——编辑器状态流入会话文档（防抖保存）与会话文档流回编辑器状态（打开
 * 项目）都依赖该兼容性；契约破坏时探针类型不再满足约束，严格检查非零
 * 退出。本文件同时承载原 model/typeContracts.test-d.ts 中编辑器运行态
 * 与补丁面的同款探针（issue #231）。
 */
import type { ShotRef as RuntimeShotRef } from '../../model/document'
import type { SessionEdge, SessionNode } from '../../model/session'
import type { PatchShape } from './patch'
import type { CanvasNode, LinePatch, SceneNodeData } from './types'

type Extends<A, B> = A extends B ? true : false
type Expect<T extends true> = T
type Reject<R extends false> = R

/** 运行态 ShotRef（model/document 领域形状，编辑器经再导出使用）：
 * 引用位/自由位互斥——镜像字段既不接受字符串也不接受显式 undefined。 */
export type RuntimeShotRefReferenceArmRejectsLabel = Reject<
  Extends<
    { id: string; kind: 'character'; assetId: string; label: undefined },
    RuntimeShotRef
  >
>
export type RuntimeShotRefFreeArmRejectsAssetId = Reject<
  Extends<
    { id: string; kind: 'location'; label: string; assetId: undefined },
    RuntimeShotRef
  >
>

/** 场景补丁允许对可选字段显式 undefined（issue #231 验收：清除与缺省的
 * 区分收口在补丁类型，不在领域形状）。 */
export type ScenePatchAllowsClearingEpisodeNo = Expect<
  Extends<{ episodeNo: number | undefined }, PatchShape<SceneNodeData>>
>

/** 对白行级补丁同款清除通道（kind 切换清空 speaker/side、说话人选择清空
 * speaker）。 */
export type LinePatchAllowsClearingSpeaker = Expect<
  Extends<{ speaker: undefined }, LinePatch>
>

/** 双向兼容（issue #353）：编辑器运行态节点流入会话文档（保存方向），
 * 会话文档节点流回编辑器状态（打开方向）。任一方向破坏即严格检查失败。 */
export type CanvasNodeFlowsIntoSession = Expect<
  Extends<CanvasNode, SessionNode>
>
export type SessionFlowsBackIntoCanvasNode = Expect<
  Extends<SessionNode, CanvasNode>
>
export type CanvasNodeArrayFlowsIntoSession = Expect<
  Extends<CanvasNode[], SessionNode[]>
>
export type SessionArrayFlowsBackIntoCanvasNode = Expect<
  Extends<SessionNode[], CanvasNode[]>
>

/** 边同款双向兼容：React Flow Edge ⇄ model/session SessionEdge。 */
export type ReactFlowEdgeFlowsIntoSession = Expect<
  Extends<CanvasEdge, SessionEdge>
>
export type SessionEdgeFlowsBackIntoReactFlowEdge = Expect<
  Extends<SessionEdge, CanvasEdge>
>
export type ReactFlowEdgeArrayFlowsIntoSession = Expect<
  Extends<CanvasEdge[], SessionEdge[]>
>

/** React Flow Edge 的本仓使用形状（库默认实例）。 */
type CanvasEdge = import('@xyflow/react').Edge
