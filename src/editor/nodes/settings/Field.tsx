import type { ReactNode } from 'react'

/** ⚙️ 设置表单的字段行：小标签 + 控件（各类型表单共用）。 */
export default function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <label className="pw-set-field">
      <span className="pw-set-label">{label}</span>
      {children}
    </label>
  )
}
