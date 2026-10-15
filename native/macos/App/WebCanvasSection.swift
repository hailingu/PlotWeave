import SwiftUI

/// One mounted WKWebView survives native navigation and panels; only the page generation owns the edit session.
struct WebCanvasSection: View {
    /// The mounted page owns its own load generation independently of app navigation.
    @State private var state = WebCanvasState()
    /// The shell's system appearance observation outlives native route changes.
    let appearance: CanvasAppearanceState
    /// Only hosted integration tests select the isolated memory canvas.
    var demoMode = false
    /// Isolated-fixture fragment: the 9-node demo default, or a registered
    /// `perf:N` scale for M15 measurement runs (issue #523).
    var demoFragment: String = "fixture"
    /// Native navigation consumes the page's read-only application projection.
    var application: NativeApplicationState? = nil
    /// Test services are explicit; production lazily selects its independent data root.
    var services: NativeHostServices? = nil

    /// Fixture mode is explicit and never initializes production application data.
    private var fixtureURL: URL? {
        guard demoMode, let url = Bundle.main.url(forResource: "native-canvas", withExtension: "html") else { return nil }
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        components?.fragment = demoFragment
        return components?.url
    }

    var body: some View {
        ZStack {
            WebCanvasHostView(
                state: state, appearance: appearance, entryURL: fixtureURL, services: services,
                onProjection: { body in
                    do { try application?.receiveProjection(body) }
                    catch { application?.invalidate(error.localizedDescription) }
                },
                onConnection: { application?.connect($0) },
                isPresented: canvasPresented
            )
            .opacity(canvasPresented ? 1 : 0)
            .allowsHitTesting(demoMode || application?.route == "editor")
            .accessibilityHidden(!canvasPresented)
            if !demoMode, state.phase == .ready, let application {
                switch application.route {
                case "home": EmptyView() // The separate native welcome window presents this read-only route.
                case "settings": NativeSettingsView(state: application)
                default: EmptyView()
                }
            }
            CanvasLoadOverlay(state: state, demoMode: demoMode)
        }
        .overlay(alignment: .bottom) {
            if !demoMode, application?.route == "editor", state.phase == .ready, let application {
                NativeCanvasZoom(state: application).padding(.bottom, 18)
            }
        }
        .onChange(of: state.phase) { _, phase in
            if case .failed(let message) = phase { application?.invalidate(message) }
        }
    }

    /// Loading stays visible for the ready handshake; native business routes
    /// then hide the retained editing surface and release its keyboard focus.
    private var canvasPresented: Bool {
        demoMode || state.phase != .ready || application?.route == "editor"
    }
}

/// Loading and recovery remain visible even when a native business screen normally covers the canvas.
private struct CanvasLoadOverlay: View {
    let state: WebCanvasState
    let demoMode: Bool

    var body: some View {
        switch state.phase {
        case .ready: EmptyView()
        case .loading:
            VStack(spacing: 12) { ProgressView(); Text(demoMode ? "正在加载画布演示…" : "正在加载项目…") }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(nsColor: .windowBackgroundColor))
        case .failed(let message):
            VStack(spacing: 12) {
                Image(systemName: "exclamationmark.triangle").font(.largeTitle)
                Text(message).multilineTextAlignment(.center)
                Button("重试加载") { state.retry() }
            }
            .padding(32).frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color(nsColor: .windowBackgroundColor))
        }
    }
}

/// Public React Flow zoom commands are view operations and do not mutate a second graph.
private struct NativeCanvasZoom: View {
    let state: NativeApplicationState

    var body: some View {
        HStack(spacing: 8) {
            Button("缩小", systemImage: "minus.magnifyingglass") { state.sendEditor("editor.zoomOut") }
            Text("\(Int(state.canvasZoom * 100))%")
                .monospacedDigit().foregroundStyle(.secondary)
            Button("放大", systemImage: "plus.magnifyingglass") { state.sendEditor("editor.zoomIn") }
            Button("适应画布", systemImage: "arrow.up.left.and.arrow.down.right") { state.sendEditor("editor.fit") }
        }
        .labelStyle(.iconOnly).controlSize(.small)
        .padding(.horizontal, 12).padding(.vertical, 8)
        .glassEffect(.regular, in: .capsule)
        .disabled(state.busy)
    }
}
