/** 错误值 → 横幅文案：Error 取 message，其余类型安全字符串化
 * （String(对象) 只会得到 '[object Object]'）。保存失败 / 拖放导入失败共用。 */
export function errorBannerMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err) ?? '未知错误'
  } catch {
    return '未知错误'
  }
}
