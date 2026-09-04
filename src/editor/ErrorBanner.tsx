/** 顶部横幅：role=alert，深红底——保存/导入失败的持续可见提示（§10.2 用户可见诊断）。 */
export default function ErrorBanner({ message }: { readonly message: string }) {
  return (
    <div
      role="alert"
      style={{
        padding: '6px 16px',
        background: '#5c1d1d',
        color: '#ffe3e3',
        fontSize: 13,
      }}
    >
      {message}
    </div>
  )
}
