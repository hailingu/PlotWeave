import Foundation

/// Delivery stage of the native macOS shell, shown in the canvas overlays so
/// an early build is never mistaken for the finished product.
///
/// After the P1 visual slice the WKWebView canvas hosts the in-memory demo
/// fixture, so the record says the web canvas IS hosted while staying
/// explicit that nothing persists (`docs/swiftui-react-flow-migration-plan.md`
/// §5).
struct ShellStage: Equatable {
    /// Title of the shell, used by overlays and diagnostics.
    let title: String

    /// Human-readable statement of what the current shell can and cannot do.
    let summary: String

    /// Whether this stage hosts the web editing canvas in a WKWebView.
    let includesWebCanvas: Bool

    /// Whether edits go anywhere beyond memory; the P1 demo fixture does not.
    let persistEdits: Bool

    /// The stage delivered by the current revision.
    static let current = ShellStage(
        title: "PlotWeave 原生外壳",
        summary: "P1 视觉首片：画布已加载内存演示数据（拖拽 / 连线 / 平移 / 缩放可用）；保存、AI 与数据链路尚未接入。",
        includesWebCanvas: true,
        persistEdits: false
    )
}
