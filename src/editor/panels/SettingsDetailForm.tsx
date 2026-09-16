import {
  useEffect,
  useId,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'

/**
 * 设定条目侧栏详情表单（issue 95）：名称单行输入 + 小传/备注多行输入，
 * 显式「保存」= 一次命令入栈可撤销，「取消」/Esc 放弃草稿不改已提交内容。
 * 名称去空白后为空禁用保存（与 createCharacter/EditableName 的非空契约
 * 一致）。草稿只落本地 state，组合输入天然安全（同 EditableName，
 * issue #42）；组合中的 Esc 不误关表单，Esc 在表单全部焦点控件（含操作
 * 按钮）可用。未触碰字段持续跟随最新已提交值——行内改名等并发提交不被
 * 旧草稿静默回退；已触碰字段保留用户草稿（快照基线边界，PR #97 评审）。
 * 字段基线为展开时的实体值；描述直接映射 bio/note，不建平行存储。
 */

/**
 * 单字段草稿：未触碰时跟随最新已提交值（行内改名等并发提交不被旧草稿
 * 回退），进入用户编辑即停止跟随、保留草稿（触碰感知基线，PR #97 评审）。
 */
function useFieldDraft(baseline: string) {
  const [value, setValue] = useState(baseline)
  const [dirty, setDirty] = useState(false)
  useEffect(() => {
    if (!dirty) setValue(baseline)
  }, [baseline, dirty])
  return {
    value,
    /** 进入用户编辑：置触碰标记并落草稿。 */
    edit: (next: string) => {
      setDirty(true)
      setValue(next)
    },
  }
}

/** 表单操作行：取消/Esc 丢弃草稿关闭；保存受名称非空契约约束
 * （Esc 处理器挂原生按钮，S6848 安全）。 */
function DetailActions({
  canSave,
  escClose,
  onSave,
  onClose,
}: {
  readonly canSave: boolean
  readonly escClose: (e: ReactKeyboardEvent<HTMLElement>) => void
  readonly onSave: () => void
  readonly onClose: () => void
}) {
  return (
    <div className="pw-settings-detail-actions">
      <button
        type="button"
        className="pw-dialog-btn"
        onClick={onClose}
        onKeyDown={escClose}
      >
        取消
      </button>
      <button
        type="button"
        className="pw-dialog-btn pw-dialog-btn-primary"
        disabled={!canSave}
        onClick={onSave}
        onKeyDown={escClose}
      >
        保存
      </button>
    </div>
  )
}

/** 展开控件（条目行的 ▸/▾ 折叠钮）→ 表单 -> 保存/取消的最小编辑单元。 */
export function SettingsDetailForm({
  nameField,
  descField,
  baselineName,
  description,
  onSave,
  onClose,
}: {
  /** 名称字段标签（如「角色名称」/「地点名称」）。 */
  readonly nameField: string
  /** 描述字段标签（如「角色小传」/「地点备注」）。 */
  readonly descField: string
  /** 展开时的名称现值（表单基线）。 */
  readonly baselineName: string
  /** 展开时的描述现值（表单基线）。 */
  readonly description: string
  /** 保存回调：名称已去空白且非空，描述为多行原文。 */
  readonly onSave: (name: string, description: string) => void
  /** 放弃草稿并收起表单。 */
  readonly onClose: () => void
}) {
  const idPrefix = useId()
  const name = useFieldDraft(baselineName)
  const desc = useFieldDraft(description)
  // 组合中的 Esc 只取消输入法合成，不收起表单（isComposing 守卫）；
  // 处理器挂在原生交互控件上（S6848：非交互元素不承接键盘事件）
  const escClose = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape' && !e.nativeEvent.isComposing) onClose()
  }
  return (
    <div className="pw-settings-detail">
      <label className="pw-settings-detail-label" htmlFor={`${idPrefix}-name`}>
        {nameField}
      </label>
      <input
        id={`${idPrefix}-name`}
        className="pw-settings-detail-input"
        autoFocus
        value={name.value}
        onChange={(e) => name.edit(e.target.value)}
        onKeyDown={escClose}
      />
      <label className="pw-settings-detail-label" htmlFor={`${idPrefix}-desc`}>
        {descField}
      </label>
      <textarea
        id={`${idPrefix}-desc`}
        className="pw-settings-detail-body"
        rows={4}
        value={desc.value}
        onChange={(e) => desc.edit(e.target.value)}
        onKeyDown={escClose}
      />
      <DetailActions
        canSave={name.value.trim() !== ''}
        escClose={escClose}
        onSave={() => onSave(name.value.trim(), desc.value)}
        onClose={onClose}
      />
    </div>
  )
}
