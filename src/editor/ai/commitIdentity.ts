/**
 * AI 执行卡的提交身份契约（§12.2 提交身份，issue #139）：跨边界的叶子
 * 契约模块——`AiThread`（面板实现）、`RightPanel`/`EditorLayout`/
 * `EditorView`（装配与布局壳）共同导入，类型不挂在任何实现入口上
 * （docs/development/software-engineering-standard.md「Dependency Design」）。
 */

/** 执行卡的提交身份：批次计数必带、画布确认等待器可选——嵌套形状在
 * 类型层固定两者耦合（等待器存在 ⇒ 计数必在）。要推迟 executed 落盘
 * （等待器存在）而缺计数的装配，会让未确认卡落盘降级 pending 后没有
 * aiRevisionAfter 对账身份，重开时已随画布落盘的批次可被再次执行；
 * 该误配形态不可构造。只带计数的形态供恢复会话对账（不等提交）；
 * 省略整组为无持久化的隔离装配——执行成功立即 executed，不进入未确认态。 */
export interface AiCommitIdentity {
  /** 画布批次计数（§12.2 提交身份）：执行后 +1 记录到卡片，恢复时对账。 */
  readonly aiRevision: number
  /** 承载批次的画布文档确认落盘后兑现；执行卡据此推迟 executed 落盘。 */
  readonly whenCanvasCommitted?: () => Promise<void>
}
