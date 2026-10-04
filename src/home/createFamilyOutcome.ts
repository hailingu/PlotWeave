/** 首页创建族的结果契约，由尝试协调器产出、失败反馈消费。只有 absent
 * 可重试；present 可能部分提交，unknown 不可推断成功或未提交。 */
export type CreateFamilyOutcome =
  | { readonly kind: 'created'; readonly id: string }
  | {
      readonly kind: 'rejected'
      readonly err: unknown
      readonly commitState: 'absent' | 'present' | 'unknown'
    }
