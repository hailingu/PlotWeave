/**
 * 双击内联改名（docs/ui-design.md §4.3 名称在卡片头部；§3.3 项目名单击改名）。
 * 双击进入编辑（节点名称），或单击进入（工具栏项目名，singleClick）；
 * Enter/失焦提交、Esc 取消；空值不提交。非编辑态是原生 button：
 * Tab 可聚焦，Enter/Space 进入编辑（S1082/S6848）。
 * 组合输入天然安全：编辑值只落本地 draft，提交在失焦/Enter（issue #42）。
 * 自 NodeSettingsPanel.tsx 外置（issue #39）：改名是卡片/工具栏通用交互，
 * 不属设置面板域；NodeSettingsPanel 经 re-export 保持既有导入路径。
 */
import { useState } from 'react'

export function EditableName({
  value,
  onChange,
  ariaLabel,
  singleClick = false,
}: {
  readonly value: string
  readonly onChange: (next: string) => void
  readonly ariaLabel: string
  /** true = 单击进入编辑（工具栏项目名）；默认双击（节点名称）。 */
  readonly singleClick?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)

  const beginEdit = (e: { stopPropagation: () => void }) => {
    e.stopPropagation()
    setDraft(value)
    setEditing(true)
  }

  if (!editing) {
    return (
      <button
        type="button"
        className="pw-editable"
        title={singleClick ? '点击重命名' : '双击改名'}
        onClick={singleClick ? beginEdit : undefined}
        onDoubleClick={singleClick ? undefined : beginEdit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            // preventDefault 抑制按钮原生 click，避免键盘激活重复触发
            e.preventDefault()
            beginEdit(e)
          }
        }}
      >
        {value}
      </button>
    )
  }
  return (
    <input
      className="pw-rename nodrag"
      autoFocus
      aria-label={ariaLabel}
      value={draft}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setEditing(false)
        const next = draft.trim()
        if (next && next !== value) onChange(next)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          setDraft(value)
          setEditing(false)
        }
      }}
    />
  )
}
