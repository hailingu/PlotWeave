import SwiftUI
import WebKit

/// AppKit WKWebView host for the web canvas (`docs/swiftui-react-flow-migration-plan.md`
/// §2.2/§4.1): public WebKit API only, opaque canvas, navigation restricted
/// to trusted bundle content. Native magnification stays off so canvas zoom
/// belongs to React Flow alone (no double zoom, M03).
struct WebCanvasHostView: NSViewRepresentable {

    let state: WebCanvasState
    let appearance: CanvasAppearanceState
    /// Optional fixture entry keeps the P1 regression separate from the production application.
    var entryURL: URL? = nil
    /// Explicit services injection isolates real business tests from all application-support roots.
    var services: NativeHostServices? = nil
    /// Native UI consumes only a read projection of the Web-owned document.
    var onProjection: (([String: Any]) -> Void)? = nil
    /// Publishes the owned coordinator for native intent dispatch without rebuilding the WebView.
    var onConnection: ((WebCanvasCoordinator) -> Void)? = nil

    /// Visibility belongs to shell navigation, independent of page lifecycle.
    var isPresented = true
    /// Loading may keep Web layout active while native fields are still preparing; release keyboard input independently.
    var acceptsInput = true

    func makeCoordinator() -> WebCanvasCoordinator {
        WebCanvasCoordinator(
            state: state, appearance: appearance, entryURL: entryURL, services: services,
            onProjection: onProjection, onConnection: onConnection
        )
    }

    /// Creates one retained canvas; Debug opts in to public WebKit timeline inspection.
    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(
            context.coordinator,
            name: WebCanvasCoordinator.bridgeName
        )
        context.coordinator.configureMedia(in: configuration)
        let webView = NativeCanvasWebView(frame: .zero, configuration: configuration)
        webView.identifier = NSUserInterfaceItemIdentifier("plotweave.canvas")
        webView.navigationDelegate = context.coordinator
        webView.allowsMagnification = false
        #if DEBUG
        webView.isInspectable = true
        #endif
        context.coordinator.loadCanvas(into: webView)
        context.coordinator.startAppearanceSync()
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        webView.isHidden = !isPresented
        // SwiftUI opacity and FocusState alone do not resign a WebKit first
        // responder. Release only this hidden canvas's responder, leaving
        // another window or an already-focused home control untouched.
        if (!isPresented || !acceptsInput), let window = webView.window,
            let responder = window.firstResponder as? NSView,
            responder.isDescendant(of: webView) {
            window.makeFirstResponder(nil)
        }
        context.coordinator.reloadIfNeeded(into: webView)
    }

    /// Detaches the reply handler and invalidates the page when the owning view disappears.
    static func dismantleNSView(_ webView: WKWebView, coordinator: WebCanvasCoordinator) {
        coordinator.invalidateSession()
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "plotweaveHost")
        webView.configuration.userContentController.removeScriptMessageHandler(forName: WebCanvasCoordinator.bridgeName)
    }

}

/// Actual view-to-window attachment supplies exit ownership before the hosted page's loading/listener handshake.
@MainActor
private final class NativeCanvasWebView: WKWebView {
    /// SwiftUI may mount content after AppKit announces main status; the host uses its stable native canvas marker.
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if let window { NotificationCenter.default.post(name: NativeApplicationDelegate.canvasWindowAttached, object: window) }
    }
}

/// Bridges WKWebView lifecycle events into ``WebCanvasState``: the web ready
/// handshake (script message), navigation failures (diagnostics), the ready
/// timeout, retry-triggered reloads, and appearance-semantics pushes
/// (plan §2.2). WKWebView delivers callbacks on the main thread.
@MainActor
final class WebCanvasCoordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler, WKScriptMessageHandlerWithReply {

    /// Configuration is completed before WKWebView creation, using the same shared native asset actors.
    func configureMedia(in configuration: WKWebViewConfiguration) {
        let handler = services.makeMediaScheme()
        mediaScheme = handler
        if let handler { configuration.setURLSchemeHandler(handler, forURLScheme: "pwmedia") }
    }

    /// Message-handler name used by the web canvas ready handshake.
    static let bridgeName = "canvasHost"

    /// Seconds without the ready handshake before reporting a failure.
    private static let readyTimeout: TimeInterval = 15

    /// Request/session owner shared by service replies, projections and native intent dispatch.
    private let router: HostCommandRouter
    /// Service lifetime is owned with the hosted page, rather than by an unowned asynchronous callback.
    private let services: NativeHostServices
    /// Scheme tasks belong to this same page owner and are cancelled on teardown or retry.
    private var mediaScheme: NativeMediaScheme?
    /// Current page UUID, advertised through the document-start marker.
    var sessionId: String { router.sessionId }
    /// Production native request IDs remain monotonic for the retained document, independently of mounted presentation owners.
    private var nativeIntentOrdinal = 0

    /// Allocates a canonical JavaScript-safe identity; only a real document load resets the retirement sequence.
    func nextNativeIntentId() throws -> String {
        guard router.isActive else { throw HostFailure(code: "PW_STALE_SESSION", message: "原生命令所属页面已失效") }
        guard nativeIntentOrdinal < 9_007_199_254_740_991 else {
            throw HostFailure(code: "PW_NATIVE_INTENT_SEQUENCE_EXHAUSTED", message: "原生命令身份空间已耗尽，请保存并重新加载页面")
        }
        nativeIntentOrdinal += 1
        return "native:\(nativeIntentOrdinal)"
    }
    /// The native application registers a current-page barrier before delivering quit to Web save owners.
    var drainNativeIntents: (() async throws -> Void)?
    /// Final approval must also reject native actions admitted after quit event delivery.
    var hasPendingNativeIntents: (() -> Bool)?
    /// Optional fixture supplied by deterministic native tests.
    private let entryOverride: URL?
    /// Accepted URL is fixed by the host, never supplied by a Web request.
    private var trustedEntry: URL?
    /// This coordinator's injected script is replaced on retry while preserving other observers.
    private var hostScript: WKUserScript?
    /// Native UI observes projections without owning a mutable document copy.
    private let onProjection: (([String: Any]) -> Void)?
    /// Native application stores a weak coordinator reference for commands.
    private let onConnection: ((WebCanvasCoordinator) -> Void)?
    private let state: WebCanvasState
    private let appearance: CanvasAppearanceState
    private weak var webView: WKWebView?
    private var loadedReloadToken = 0
    private var readyTimeoutTask: Task<Void, Never>?

    init(
        state: WebCanvasState,
        appearance: CanvasAppearanceState,
        entryURL: URL? = nil,
        services: NativeHostServices? = nil,
        router: HostCommandRouter? = nil,
        onProjection: (([String: Any]) -> Void)? = nil,
        onConnection: ((WebCanvasCoordinator) -> Void)? = nil
    ) {
        self.state = state
        self.appearance = appearance
        self.entryOverride = entryURL
        let services = services ?? NativeHostServices.shared
        self.services = services
        self.router = router ?? HostCommandRouter(service: services.perform)
        self.onProjection = onProjection
        self.onConnection = onConnection
    }

    deinit {
        readyTimeoutTask?.cancel()
    }

    /// Attaches the appearance change handler; called once the host owns its
    /// WKWebView so pushes never race view creation.
    func startAppearanceSync() {
        appearance.onSnapshotChange = { [weak self] snapshot in
            self?.pushAppearance(snapshot)
        }
    }

    /// Pushes host appearance semantics into the live page; the optional-
    /// call form stays a no-op before the web side registers its handler.
    private func pushAppearance(_ snapshot: CanvasAppearanceState.Snapshot) {
        webView?.evaluateJavaScript(
            "window.__pwApplyHostAppearance && "
                + "window.__pwApplyHostAppearance(\(snapshot.payloadJSON))",
            completionHandler: nil
        )
    }

    /// Loads the canvas entry page and (re)starts the ready timeout.
    func loadCanvas(into webView: WKWebView) {
        if self.webView !== webView {
            webView.configuration.userContentController.addScriptMessageHandler(
                self, contentWorld: .page, name: "plotweaveHost"
            )
        }
        self.webView = webView
        mediaScheme?.cancelAll()
        router.beginSession()
        nativeIntentOrdinal = 0
        services.connect(self)
        installHostScript(in: webView.configuration.userContentController)
        loadedReloadToken = state.reloadToken
        if let entry = entryOverride ?? Self.canvasEntryURL() {
            trustedEntry = entry
            onConnection?(self)
            startReadyTimeout()
            webView.loadFileURL(
                entry,
                allowingReadAccessTo: entry.deletingLastPathComponent()
            )
        } else {
            invalidateSession(canvasFailed: true)
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
            do { try await Task.sleep(for: .seconds(Self.readyTimeout)) }
            catch { return } // Cancellation ends this owned deadline without a canvas failure.
            guard !Task.isCancelled, let self else { return }
            self.invalidateSession(canvasFailed: true)
            self.state.fail("画布在 \(Int(Self.readyTimeout)) 秒内未报告就绪。")
        }
    }

    // MARK: WKScriptMessageHandler — web ready handshake.

    /// Handles the compatible ready handshake and session-bound read projections.
    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard router.isActive, message.name == Self.bridgeName, isTrusted(message),
              let body = message.body as? [String: Any] else { return }
        if body["event"] as? String == "ready" {
            readyTimeoutTask?.cancel()
            state.markReady()
            pushAppearance(appearance.snapshot)
            onConnection?(self)
        } else if body["event"] as? String == "projection",
                  body["protocolVersion"] as? Int == 1,
                  body["sessionId"] as? String == sessionId,
                  body["projection"] is [String: Any] {
            onProjection?(body)
        }
    }

    /// Reply-capable protocol entry; bridge failures are returned as structured business replies.
    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void
    ) {
        let body = message.body
        let trusted = isTrusted(message)
        // WebKit owns a reply obligation; the router owns and cancels the session's business work.
        // This adapter must still return that work's structured stale/failure result after teardown,
        // rather than cancelling only the waiter and abandoning WebKit's reply handler.
        Task { @MainActor [router] in
            let reply = await router.handle(body, trustedMainFrame: trusted)
            replyHandler(reply.webValue, nil)
        }
    }

    /// Native intents await the Web action entry; document state never crosses into Swift ownership.
    func sendNativeIntent(request: [String: Any]) async throws -> Any {
        guard router.isActive else { throw HostFailure(code: "PW_STALE_SESSION", message: "页面会话已失效，本次结果未知") }
        guard let webView, state.phase == .ready else {
            throw HostFailure(code: "PW_CANVAS_NOT_READY", message: "画布尚未就绪")
        }
        let session = sessionId
        let response = try await webView.callAsyncJavaScript(
            "return await window.__pwNativeIntent(request)",
            arguments: ["request": request], in: nil, contentWorld: .page
        )
        guard router.isActive, sessionId == session else {
            throw HostFailure(code: "PW_STALE_SESSION", message: "页面会话已失效，本次结果未知")
        }
        guard let response else {
            throw HostFailure(code: "PW_INVALID_REPLY", message: "原生命令未返回有效回执")
        }
        return response
    }

    /// Delivers named host events using arguments rather than interpolating business text into JavaScript.
    func dispatchEvent(_ name: String, payload: HostJSON) async throws {
        guard router.isActive, let webView else { throw HostFailure(code: "PW_STALE_SESSION", message: "宿主事件对应的页面已失效") }
        _ = try await webView.callAsyncJavaScript(
            "if (!window.__pwDispatchHostEvent) throw new Error('PW_EVENT_HANDLER_UNAVAILABLE'); window.__pwDispatchHostEvent(name, payload)",
            arguments: ["name": name, "payload": payload.webValue], in: nil, contentWorld: .page
        )
    }

    /// Invalidates writes and projections when the Web owner is removed or its content process dies.
    /// Failure entry points keep a pending native close/quit for the visible degraded decision instead of
    /// discarding it with the listener; ordinary teardown retains the existing cancel/reset behavior.
    func invalidateSession(canvasFailed: Bool = false) {
        mediaScheme?.cancelAll()
        router.invalidate()
        services.invalidateQuitListener(for: self, canvasFailed: canvasFailed)
        readyTimeoutTask?.cancel()
    }

    /// Content-process termination is a visible failure and never an empty project to save.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        invalidateSession(canvasFailed: true)
        state.fail("画布进程已终止，请重新加载已保存项目；未落盘编辑无法确认恢复。")
    }

    /// Trust requires both the main frame and the exact entry URL selected by the host.
    private func isTrusted(_ message: WKScriptMessage) -> Bool {
        message.frameInfo.isMainFrame && matchesEntry(message.frameInfo.request.url)
    }

    /// Fragments select an application fixture but cannot expand the trusted file scope.
    private func matchesEntry(_ url: URL?) -> Bool {
        guard let url, let trustedEntry, url.isFileURL else { return false }
        return url.deletingFragment().standardizedFileURL == trustedEntry.deletingFragment().standardizedFileURL
    }

    /// Replaces only our document-start script so test observers and unrelated scripts remain installed.
    private func installHostScript(in controller: WKUserContentController) {
        let others = controller.userScripts.filter { $0 !== hostScript }
        controller.removeAllUserScripts()
        others.forEach(controller.addUserScript)
        let marker: HostJSON = .object([
            "kind": .string("swift"), "protocolVersion": .number(1),
            "sessionId": .string(sessionId)
        ])
        let markerData = (try? JSONEncoder().encode(marker)) ?? Data()
        let markerText = String(decoding: markerData, as: UTF8.self)
        let script = WKUserScript(source: """
            window.__pwHostAppearance = \(appearance.snapshot.payloadJSON);
            window.__pwNativeHost = \(markerText);
            """, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        hostScript = script
        controller.addUserScript(script)
    }

    // MARK: WKNavigationDelegate — failures surface as diagnostics.

    func webView(
        _ webView: WKWebView,
        didFail navigation: WKNavigation!,
        withError error: Error
    ) {
        invalidateSession(canvasFailed: true)
        state.fail("画布加载失败：\(error.localizedDescription)")
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        invalidateSession(canvasFailed: true)
        state.fail("画布导航失败：\(error.localizedDescription)")
    }

    /// Navigation restricted to application-trusted file content (§4.1);
    /// everything else is cancelled and visible only as a no-op.
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction
    ) async -> WKNavigationActionPolicy {
        matchesEntry(navigationAction.request.url) ? .allow : .cancel
    }
}

/// Removes only a URL fragment when comparing the host's trusted page identity.
private extension URL {
    func deletingFragment() -> URL {
        guard var parts = URLComponents(url: self, resolvingAgainstBaseURL: false) else { return self }
        parts.fragment = nil
        return parts.url ?? self
    }
}
