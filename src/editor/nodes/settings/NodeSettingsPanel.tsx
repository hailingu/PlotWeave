import { useNodeEdit } from '../../nodeEdit'
import ImageNodeForm from './ImageNodeForm'
import SceneForm from './SceneForm'
import BeatForm from './BeatForm'
import DialogueForm from './DialogueForm'
import BranchForm from './BranchForm'
import ShotForm from './ShotForm'
import type {
  BeatNodeData,
  BranchNodeData,
  DialogueNodeData,
  ImageNodeData,
  SceneNodeData,
  ShotNodeData,
} from '../types'

/**
 * ⚙️ 设置面板 = 节点编辑器（docs/ui-design.md §4.3）。
 * 以卡片为锚在下方弹簧展开（半透明 blur），承载该节点类型的全部字段；
 * 编辑即命令——每次修改实时 patch 节点 data，无「保存」按钮；
 * 底部为 ⧉ 复制与 🗑 删除（danger 色）。失焦（外部点击）收起。
 * 根节点带 nodrag/nowheel：面板内的输入与滚动不触发画布拖拽缩放。
 *
 * 各节点类型表单独立文件（issue #39，ImageNodeForm.tsx 先例）：
 * SceneForm/BeatForm/DialogueForm/BranchForm/ShotForm；共享分区
 * EpisodeField；内联改名 EditableName（通用交互，外置后经此
 * re-export 保持既有导入路径）。本文件保留面板入参类型与外壳分发。
 */

/** 面板入参：id + 类型 + 该类型 data 的判别联合（NodeProps 不含完整 node）。 */
export type PanelNode =
  | { id: string; type: 'scene'; data: SceneNodeData }
  | { id: string; type: 'beat'; data: BeatNodeData }
  | { id: string; type: 'dialogue'; data: DialogueNodeData }
  | { id: string; type: 'branch'; data: BranchNodeData }
  | { id: string; type: 'shot'; data: ShotNodeData }
  | { id: string; type: 'image'; data: ImageNodeData }

export { EditableName } from './EditableName'

/**
 * 设置面板外壳：按节点类型分发表单；底部 ⧉ 复制 / 🗑 删除（§4.3）。
 * 由各节点组件在 openSettingsId 命中时渲染于卡片下方。
 */
export default function NodeSettingsPanel({ node }: { readonly node: PanelNode }) {
  const { duplicateNode, deleteNode, settings } = useNodeEdit()

  return (
    // 内嵌表单面板而非模态对话框：原生 section 地标（S6819），不冒用 dialog 角色
    <section
      className="pw-settings nodrag nowheel"
      data-pw-settings
      aria-label="节点设置"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="pw-settings-scroll">
        {node.type === 'scene' && <SceneForm node={node} settings={settings} />}
        {node.type === 'beat' && <BeatForm node={node} />}
        {node.type === 'dialogue' && <DialogueForm node={node} settings={settings} />}
        {node.type === 'branch' && <BranchForm node={node} />}
        {node.type === 'shot' && <ShotForm node={node} />}
        {node.type === 'image' && <ImageNodeForm node={node} />}
      </div>
      <div className="pw-settings-actions">
        <button
          type="button"
          className="pw-set-action"
          onClick={() => duplicateNode(node.id)}
        >
          ⧉ 复制
        </button>
        <span className="pw-sp" />
        <button
          type="button"
          className="pw-set-action pw-set-danger"
          onClick={() => deleteNode(node.id)}
        >
          🗑 删除
        </button>
      </div>
    </section>
  )
}
