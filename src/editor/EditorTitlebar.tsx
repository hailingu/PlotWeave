/**
 * 编辑器标题栏（docs/ui-design.md §3.3）：整行作为窗口拖拽区（按钮除外）。
 * 左 = 边栏开关 / 撤销 / 重做 / 返回首页；中 = 项目名（单击内联重命名）；
 * 右 = ＋节点下拉 / ⤓ 导出 / ◫ 检查器 / ✦AI。纯展示组件，状态由
 * EditorWindow 持有（＋菜单的开合同时受全局失焦收起约束）。
 */
import { CREATE_LABELS, CREATABLE_TYPES, type CreatableType } from './creatable'
import { EditableName } from './nodes/settings/NodeSettingsPanel'
import type { RightTab } from './panels/RightPanel'

export interface EditorTitlebarProps {
  /** 项目名（中区展示 + 单击重命名）。 */
  readonly projectName: string
  readonly onRenameProject: (name: string) => void
  /** 左边栏显隐。 */
  readonly leftOpen: boolean
  readonly onToggleLeft: () => void
  /** 撤销/重做可用态与动作（§3.3）。 */
  readonly canUndo: boolean
  readonly canRedo: boolean
  readonly onUndo: () => void
  readonly onRedo: () => void
  readonly onBackHome: () => void
  /** ＋节点下拉：开合态由父级持有（失焦收起 §4.3 需要外部关闭）。 */
  readonly plusOpen: boolean
  readonly onTogglePlus: () => void
  readonly onCreateNode: (type: CreatableType) => void
  readonly onOpenExport: () => void
  /** 右栏两个页的激活态（用于按钮高亮）；点击切换统一走 onToggleRight。 */
  readonly inspectorOn: boolean
  readonly aiOn: boolean
  readonly onToggleRight: (tab: RightTab) => void
}

export default function EditorTitlebar({
  projectName,
  onRenameProject,
  leftOpen,
  onToggleLeft,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onBackHome,
  plusOpen,
  onTogglePlus,
  onCreateNode,
  onOpenExport,
  inspectorOn,
  aiOn,
  onToggleRight,
}: EditorTitlebarProps) {
  return (
    <header className="editor-titlebar" data-tauri-drag-region>
      <button
        type="button"
        className={`editor-tbtn${leftOpen ? ' on' : ''}`}
        onClick={onToggleLeft}
        aria-pressed={leftOpen}
        aria-label="切换边栏"
        title="显示或隐藏边栏"
      >
        ▤
      </button>
      <button
        type="button"
        className="editor-tbtn"
        onClick={onUndo}
        disabled={!canUndo}
        aria-label="撤销"
        title="撤销 (⌘Z)"
      >
        ↩︎
      </button>
      <button
        type="button"
        className="editor-tbtn"
        onClick={onRedo}
        disabled={!canRedo}
        aria-label="重做"
        title="重做 (⌘⇧Z)"
      >
        ↪︎
      </button>
      <button type="button" className="editor-back" onClick={onBackHome} aria-label="返回首页">
        ‹ 首页
      </button>
      {/* 项目名居中（§3.3 中区）：点击内联重命名 */}
      <span className="editor-title">
        <EditableName value={projectName} ariaLabel="项目名" singleClick onChange={onRenameProject} />
      </span>
      <div className="editor-plus">
        <button
          type="button"
          className={`editor-tbtn io${plusOpen ? ' on' : ''}`}
          onClick={onTogglePlus}
          aria-pressed={plusOpen}
          aria-haspopup="menu"
          aria-expanded={plusOpen}
          aria-label="新增节点"
          title="新增节点"
        >
          ＋ 节点 ▾
        </button>
        {plusOpen && (
          <div className="editor-menu" role="menu" aria-label="节点类型">
            {CREATABLE_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                className="editor-menu-item"
                role="menuitem"
                onClick={() => onCreateNode(type)}
              >
                {CREATE_LABELS[type]}
              </button>
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        className="editor-tbtn"
        onClick={onOpenExport}
        aria-label="导出剧本"
        title="导出剧本（场景 + 对白，分镜附录）"
      >
        ⤓ 导出
      </button>
      <button
        type="button"
        className={`editor-tbtn${inspectorOn ? ' on' : ''}`}
        onClick={() => onToggleRight('inspector')}
        aria-pressed={inspectorOn}
        aria-label="切换检查器"
        title="显示或隐藏检查器"
      >
        ◫
      </button>
      <button
        type="button"
        className={`editor-tbtn editor-tbtn-ai${aiOn ? ' on' : ''}`}
        onClick={() => onToggleRight('ai')}
        aria-pressed={aiOn}
        aria-label="切换 AI 面板"
        title="显示或隐藏 ✦AI"
      >
        ✦ AI
      </button>
    </header>
  )
}
