/** 画布保存 owner 的只读状态：载入不等于保存，防抖和在途都不能宣称已落盘。 */
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'failed'

/** 状态区的有限文案；AI 会话继续使用独立的持久化及退出屏障。 */
const LABELS: Readonly<Record<SaveStatus, string>> = {
  idle: '已载入',
  saving: '保存中…',
  saved: '已保存',
  failed: '保存失败',
}

/** 将画布 owner 的状态转为不虚报成功的短文案。 */
export function saveStatusLabel(status: SaveStatus): string {
  return LABELS[status]
}
