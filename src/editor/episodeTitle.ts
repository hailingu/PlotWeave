/** 集标题映射（§3.5：集 = 编号 + 大纲行内标题，不建集实体表）的
 * 单一更新语义：标题清空 = 移除该集命名（删除键），非空 = 写入。
 * 正向应用与撤销/重做命令共用本函数，避免三处手写分支漂移
 * （SonarQube S3923：redo 曾漏掉删除分支导致与正向不一致）。 */
export function applyEpisodeTitle(
  titles: Record<number, string>,
  no: number,
  title: string,
): Record<number, string> {
  const next = title.trim()
  if (next === '') {
    if (!(no in titles)) return titles
    const rest = { ...titles }
    delete rest[no]
    return rest
  }
  return { ...titles, [no]: next }
}
