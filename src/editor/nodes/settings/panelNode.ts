import type {
  BeatNodeData,
  BranchNodeData,
  DialogueNodeData,
  ImageNodeData,
  SceneNodeData,
  ShotNodeData,
} from '../types'

/**
 * ⚙️ 设置面板的入参契约（issue 106 从 NodeSettingsPanel.tsx 抽出的稳定
 * 契约模块）：外壳按类型分发的判别联合，各类型表单（SceneForm/BeatForm/
 * DialogueForm/BranchForm/ShotForm/ImageNodeForm）据此声明自己的
 * `Extract<PanelNode, { type: ... }>` 入参——表单只依赖本模块，不再反向
 * 依赖外壳（依赖方向：表单 → panelNode ← NodeSettingsPanel）。
 */

/** 面板入参：id + 类型 + 该类型 data 的判别联合（NodeProps 不含完整 node）。 */
export type PanelNode =
  | { id: string; type: 'scene'; data: SceneNodeData }
  | { id: string; type: 'beat'; data: BeatNodeData }
  | { id: string; type: 'dialogue'; data: DialogueNodeData }
  | { id: string; type: 'branch'; data: BranchNodeData }
  | { id: string; type: 'shot'; data: ShotNodeData }
  | { id: string; type: 'image'; data: ImageNodeData }
