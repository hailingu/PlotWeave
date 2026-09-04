/**
 * 生成输入签名（docs/data-model.md §13：防旧结果覆盖新编辑）。
 * 生成完成写回 outputs 前比对触发时刻与当前时刻的签名：prompt/model/size
 * 任一前进即丢弃结果（媒体文件留存待延迟回收，§7.3），不得把旧输入的
 * 产物盖到用户已编辑的新输入上。纯函数，供生成调度与测试共用。
 */

/** 参与签名的生成输入子集（规范化：prompt 去首尾空白）。 */
export interface ImageGenInput {
  prompt: string
  model: string
  size: string
}

/** 输入子集 → 规范化签名字符串（字段定序，序列化即比较）。 */
export function imageGenSignature(input: ImageGenInput): string {
  return JSON.stringify([
    input.prompt.trim(),
    input.model,
    input.size,
  ])
}

/** 触发时刻输入与当前节点输入是否仍一致（一致才允许写回结果）。 */
export function signatureMatches(triggered: ImageGenInput, current: ImageGenInput): boolean {
  return imageGenSignature(triggered) === imageGenSignature(current)
}
