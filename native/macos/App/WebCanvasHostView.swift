import SwiftUI
import WebKit

/// AppKit WKWebView host for the web canvas (`docs/swiftui-react-flow-migration-plan.md`
/// §2.2/§4.1): public WebKit API only, opaque canvas, navigation restricted
/// to trusted bundle content. Native magnification stays off so canvas zoom
/// belongs to React Flow alone (no double zoom, M03).
struct WebCanvasHostView: NSViewRepresentable {

    let state: WebCanvasState

    func makeCoordinator() -> WebCanvasCoordinator {
        WebCanvasCoordinator(state: state)
    }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(
            context.coordinator,
            name: WebCanvasCoordinator.bridgeName
        )
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.allowsMagnification = false
        context.coordinator.loadCanvas(into: webView)
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        context.coordinator.reloadIfNeeded(into: webView)
    }
}

/// Bridges WKWebView lifecycle events into ``WebCanvasState``: the web ready
/// handshake (script message), navigation failures (diagnostics), the ready
/// timeout, and retry-triggered reloads. WKWebView delivers callbacks on the
/// main thread.
@MainActor
final class WebCanvasCoordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {

    /// Message-handler name used by the web canvas ready handshake.
    static let bridgeName = "canvasHost"

    /// Seconds without the ready handshake before reporting a failure.
    private static let readyTimeout: TimeInterval = 15

    private let state: WebCanvasState
    private weak var webView: WKWebView?
    private var loadedReloadToken = 0
    private var readyTimeoutTask: Task<Void, Never>?

    init(state: WebCanvasState) {
        self.state = state
    }

    deinit {
        readyTimeoutTask?.cancel()
    }

    /// Loads the canvas entry page and (re)starts the ready timeout.
    func loadCanvas(into webView: WKWebView) {
        self.webView = webView
        loadedReloadToken = state.reloadToken
        if let entry = Self.canvasEntryURL() {
            startReadyTimeout()
            webView.loadFileURL(
                entry,
                allowingReadAccessTo: entry.deletingLastPathComponent()
            )
        } else {
            state.fail(
                "未找到画布资源：请先在仓库根目录执行 npm run build:native-canvas，"
                    + "再重新构建应用。"
            )
        }
    }

    /// Reloads when the state's reload token moved on (retry button).
    func reloadIfNeeded(into webView: WKWebView) {
        guard state.reloadToken != loadedReloadToken else { return }
        loadCanvas(into: webView)
    }

    /// Bundle lookup for the demo entry page. Folder-synchronized resources
    /// land flattened in the bundle root; the subdirectory fallback covers a
    /// non-flattened layout.
    private static func canvasEntryURL() -> URL? {
        if let url = Bundle.main.url(forResource: "native-canvas", withExtension: "html") {
            return url
        }
        return Bundle.main.url(
            forResource: "native-canvas",
            withExtension: "html",
            subdirectory: "WebCanvas"
        )
    }

    /// Starts the ready-handshake timeout; cancelled on ready, failure, and
    /// reload so only the load that owns it can fail.
    private func startReadyTimeout() {
        readyTimeoutTask?.cancel()
        readyTimeoutTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.readyTimeout))
            guard !Task.isCancelled, let self else { return }
            self.state.fail("画布在 \(Int(Self.readyTimeout)) 秒内未报告就绪。")
        }
    }

    // MARK: WKScriptMessageHandler — web ready handshake.

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard message.name == Self.bridgeName,
              let body = message.body as? [String: Any],
              body["event"] as? String == "ready"
        else { return }
        readyTimeoutTask?.cancel()
        state.markReady()
    }

    // MARK: WKNavigationDelegate — failures surface as diagnostics.

    func webView(
        _ webView: WKWebView,
        didFail navigation: WKNavigation!,
        withError error: Error
    ) {
        readyTimeoutTask?.cancel()
        state.fail("画布加载失败：\(error.localizedDescription)")
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        readyTimeoutTask?.cancel()
        state.fail("画布导航失败：\(error.localizedDescription)")
    }

    /// Navigation restricted to application-trusted file content (§4.1);
    /// everything else is cancelled and visible only as a no-op.
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction
    ) async -> WKNavigationActionPolicy {
        navigationAction.request.url?.scheme == "file" ? .allow : .cancel
    }
}
