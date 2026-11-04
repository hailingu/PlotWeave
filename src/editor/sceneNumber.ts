/** 场次的可读编号：缺失为未编号；卡片、大纲、AI 与导出共用（#933）。 */
export function sceneNumberText(value: number | undefined): string {
  return value === undefined ? '未编号' : String(value).padStart(2, '0')
}
