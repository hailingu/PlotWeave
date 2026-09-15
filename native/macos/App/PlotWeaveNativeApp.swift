import SwiftUI

/// Entry point of the native PlotWeave shell under development on the
/// `codex/swiftui-react-flow` branch.
///
/// P1 scope: standard native shell containers (navigation sidebar, unified
/// toolbar, inspector) around a placeholder canvas. The WKWebView canvas
/// host and persisted editing chains arrive in the following slices
/// (`docs/swiftui-react-flow-migration-plan.md` §5).
@main
struct PlotWeaveNativeApp: App {
    var body: some Scene {
        WindowGroup {
            NativeShellRoot()
        }
    }
}
