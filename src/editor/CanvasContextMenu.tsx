/**
 * 画布右键上下文菜单（docs/ui-design.md §4.3：全部操作同时可从右键菜单到达）。
 * 三种形态：节点菜单（⚙️ 设置 / ⧉ 复制 / 🗑 删除）、连线菜单（✂️ 删除）、
 * 空白菜单（五类新增，复用 ＋节点 的创建项）。纯展示组件：
 * 每个动作执行后回调 onClose 由父级统一收起。
 */
import { CREATE_LABELS, CREATABLE_TYPES, type CreatableType } from './creatable'

export interface CanvasContextMenuProps {
  /** 触发点视口坐标（左缘收敛在窗口内，防贴右缘溢出）。 */
  readonly x: number
  readonly y: number
  /** 节点菜单形态：目标节点 id。 */
  readonly nodeId?: string
  /** 连线菜单形态：目标边 id。 */
  readonly edgeId?: string
  readonly onToggleSettings: (id: string) => void
  readonly onDuplicate: (id: string) => void
  readonly onDeleteNode: (id: string) => void
  readonly onDeleteEdge: (id: string) => void
  readonly onCreate: (type: CreatableType) => void
  readonly onClose: () => void
}

export default function CanvasContextMenu({
  x,
  y,
  nodeId,
  edgeId,
  onToggleSettings,
  onDuplicate,
  onDeleteNode,
  onDeleteEdge,
  onCreate,
  onClose,
}: CanvasContextMenuProps) {
  const item = (label: string, danger: boolean, act: () => void) => (
    <button
      key={label}
      type="button"
      className={`editor-menu-item${danger ? ' editor-menu-danger' : ''}`}
      role="menuitem"
      onClick={() => {
        act()
        onClose()
      }}
    >
      {label}
    </button>
  )

  let body
  if (nodeId) {
    const id = nodeId
    body = [
      item('⚙️ 打开设置', false, () => onToggleSettings(id)),
      item('⧉ 复制', false, () => onDuplicate(id)),
      item('🗑 删除', true, () => onDeleteNode(id)),
    ]
  } else if (edgeId) {
    const id = edgeId
    body = [item('✂️ 删除连线', true, () => onDeleteEdge(id))]
  } else {
    body = CREATABLE_TYPES.map((type) =>
      item(`＋ ${CREATE_LABELS[type]}`, false, () => onCreate(type)),
    )
  }

  return (
    <div
      className="editor-ctx"
      style={{ left: Math.min(x, window.innerWidth - 150), top: y }}
      role="menu"
      aria-label="画布上下文菜单"
    >
      {body}
    </div>
  )
}
