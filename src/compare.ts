/** UTF-16 码元序比较器（与 String.prototype 默认排序完全一致）。
 * 签名 / coalesceKey 等规范化场景需要与环境（ICU、locale）无关的
 * 稳定总序；显式传入比较器同时满足 SonarQube S2871。
 * 独立成函数以避免内联嵌套三元（S3358）。 */
export function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}
