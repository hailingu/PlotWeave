/**
 * 会话画布形状的模型自有类型（issue #353 方向一）：会话文档的节点/边类型
 * 由磁盘格式所有者 src/model/ 定义为最小结构接口，编辑器侧
 * （src/editor/nodes/types.ts）以结构兼容（继承/再导出）对接 React Flow
 * 运行态，而非反向引用——编辑器节点形状变更不再等价于持久化 schema 变更。
 * 字段语义契约：docs/data-model.md §4/§5；双向互转见 serialize.ts。
 */
import type {
  BeatSpec,
  BranchSpec,
  DialogueSpec,
  ImageSpec,
  Point,
  SceneSpec,
  ShotSpec,
} from './document'

/** 会话侧场景节点 data（§4.2）：落盘 spec 拍平 + name/episodeNo 上移。
 * 字符串索引签名是会话容器的运行时现实：同版本文档 spec 的未知透传键经
 * fromStoryNode 拍平混入 data，序列化边界按需剥离（serialize.ts）；
 * 该签名同时满足 React Flow Node<Data extends Record<string, unknown>>
 * 的泛型约束（issue 16，编辑器侧经继承获得）。 */
export interface SceneSessionData extends SceneSpec {
  name: string
  /** 会话必填（存储契约可选、加载归一化兜底空串，§4.2 渲染安全）。 */
  time: string
  /** 集归属（§3.5）。 */
  episodeNo?: number
  [key: string]: unknown
}

/** 会话侧对白节点 data（§4.2）：台词行列表 + 名称/分集上移。索引签名
 * 语义同 SceneSessionData。 */
export interface DialogueSessionData extends DialogueSpec {
  name: string
  episodeNo?: number
  [key: string]: unknown
}

/** 会话侧节奏卡节点 data（§4.2）。索引签名语义同 SceneSessionData。 */
export interface BeatSessionData extends BeatSpec {
  name: string
  episodeNo?: number
  [key: string]: unknown
}

/** 会话侧分支节点 data（§4.2）：分岔问句 + 选项；派生标题不落 data.name
 * 镜像（序列化剥离残留）。索引签名语义同 SceneSessionData。 */
export interface BranchSessionData extends BranchSpec {
  episodeNo?: number
  [key: string]: unknown
}

/** 会话侧分镜卡节点 data（§4.2）：与落盘 ShotSpec 同构搬运。索引签名
 * 语义同 SceneSessionData。 */
export interface ShotSessionData extends ShotSpec {
  [key: string]: unknown
}

/** 会话侧图片节点 data（§13）：与落盘 ImageSpec 同构搬运。索引签名
 * 语义同 SceneSessionData。 */
export interface ImageSessionData extends ImageSpec {
  [key: string]: unknown
}

/** 落盘 meta 时间戳透传（§4.1 演进占位字段）：编辑器不维护也不展示，
 * 加载时带上、序列化原样写回——打开→保存不得静默删除既有溯源元数据。 */
export interface NodeMetaPassthrough {
  meta?: { createdAt?: string; updatedAt?: string }
}

/** 会话画布节点基础字段：React Flow 运行态中模型消费/产生的最小投影
 * （issue #353）；selected 是会话可变态（落盘时按 §11.2 重置）。 */
export interface SessionNodeBase {
  id: string
  position: Point
  width?: number
  height?: number
  zIndex?: number
  selected?: boolean
  /** 会话展示态（pw-node-dim 等，运行态可变）：序列化剥离、不落盘。 */
  className?: string
  /** 内联声明而非 NodeMetaPassthrough['meta']：索引访问会带出显式
   * undefined，exactOptionalPropertyTypes 下与编辑器运行态不再互逆。 */
  meta?: { createdAt?: string; updatedAt?: string }
}

/** 会话画布节点判别联合：按 type 收窄到对应 data 形状；编辑器 CanvasNode
 * 与本类型双向结构兼容（赋值探针见 editor/nodes/sessionCompat.test-d.ts）。 */
export type SessionNode =
  | (SessionNodeBase & { type: 'scene'; data: SceneSessionData })
  | (SessionNodeBase & { type: 'beat'; data: BeatSessionData })
  | (SessionNodeBase & { type: 'dialogue'; data: DialogueSessionData })
  | (SessionNodeBase & { type: 'branch'; data: BranchSessionData })
  | (SessionNodeBase & { type: 'shot'; data: ShotSessionData })
  | (SessionNodeBase & { type: 'image'; data: ImageSessionData })

/** 会话画布边：React Flow Edge 中模型消费/产生的最小投影（issue #353）。
 * type/className 的字面量编码（branch / pw-edge-attach / pw-edge-sequence）
 * 与 edgeKindOf 判别同域（graphSemantics.ts）；data.order 为同端点展示
 * 排序（§5），其余 data 键按 Record 透传。type 显式含 undefined：React
 * Flow 的 EdgeType 泛型缺省为 string | undefined，显式 undefined 形态须
 * 能流入会话（exactOptionalPropertyTypes，issue #231 同口径）。 */
export interface SessionEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string | null
  targetHandle?: string | null
  type?: string | undefined
  className?: string
  data?: Record<string, unknown>
  selected?: boolean
}
