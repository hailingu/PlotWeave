/** 顶部横幅：role=alert，深红底——保存/导入失败的持续可见提示（§10.2
 * 用户可见诊断）。样式走共用 .pw-error-banner（App 退出冲刷横幅同源，
 * issue #318）：配色经语义令牌进入 sheetTokens 契约，双外观恒定。 */
export function ErrorBanner({ message }: { readonly message: string }) {
  return (
    <div role="alert" className="pw-error-banner">
      {message}
    </div>
  )
}
