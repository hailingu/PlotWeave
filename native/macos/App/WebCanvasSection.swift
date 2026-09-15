import SwiftUI

/// Canvas area of the native shell: the WKWebView canvas host with
/// load-phase overlays and the floating glass control cluster
/// (`docs/swiftui-react-flow-migration-plan.md` §2.2 — the canvas stays an
/// opaque content surface, glass lives on floating controls and chrome).
struct WebCanvasSection: View {
    @State private var state = WebCanvasState()

    var body: some View {
        ZStack {
            WebCanvasHostView(state: state)
            switch state.phase {
            case .loading:
                CanvasPhaseOverlay {
                    ProgressView()
                    Text("正在加载画布演示…")
                        .font(.headline)
                }
            case .failed(let message):
                CanvasPhaseOverlay {
                    CanvasFailureContent(message: message) {
                        state.retry()
                    }
                }
            case .ready:
                EmptyView()
            }
        }
        .overlay(alignment: .bottom) {
            CanvasGlassCluster()
                .padding(.bottom, 20)
                .opacity(state.phase == .ready ? 1 : 0)
                .animation(.default, value: state.phase)
                .accessibilityHidden(state.phase != .ready)
        }
    }
}

/// Full-cover overlay for the non-ready phases; keeps the stage summary
/// visible so the window never shows a silent blank canvas.
private struct CanvasPhaseOverlay<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        VStack(spacing: 12) {
            content
            Text(ShellStage.current.summary)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .windowBackgroundColor))
    }
}

/// Failure diagnostic with an explicit retry entry (M01: failures stay
/// visible and recoverable, never a fake empty canvas).
private struct CanvasFailureContent: View {
    let message: String
    let onRetry: () -> Void

    var body: some View {
        Image(systemName: "exclamationmark.triangle")
            .font(.system(size: 32))
            .foregroundStyle(.secondary)
        Text(message)
            .font(.headline)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 32)
        Button("重试加载") {
            onRetry()
        }
    }
}

/// Floating glass control cluster over the canvas (demo placeholders stay
/// disabled until the real canvas commands are bridged in P2/P3).
private struct CanvasGlassCluster: View {
    var body: some View {
        HStack(spacing: 4) {
            Button("缩小", systemImage: "minus.magnifyingglass") {}
                .disabled(true)
            Text("100%")
                .font(.callout)
                .monospacedDigit()
                .foregroundStyle(.secondary)
            Button("放大", systemImage: "plus.magnifyingglass") {}
                .disabled(true)
        }
        .controlSize(.small)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .glassEffect(.regular, in: .capsule)
        .help("画布缩放由触控板/滚轮手势直接操作；原生缩放命令随 P3 桥接接通")
    }
}
