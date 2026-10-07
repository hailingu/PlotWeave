import AppKit
import Testing
import WebKit
@testable import PlotWeaveNative

/// Exercises the shipped page in real WebKit: missing or unexecutable bundle
/// scripts must fail this test even when HTML navigation itself succeeds.
@MainActor
struct WebCanvasLoadingTests {

    /// M01 regression: a packaged canvas must both report ready and render nodes.
    @Test func bundledCanvasRendersAndReportsReady() async throws {
        let state = WebCanvasState()
        let appearance = CanvasAppearanceState()
        let entry = try #require(Bundle.main.url(forResource: "native-canvas", withExtension: "html"))
        var parts = try #require(URLComponents(url: entry, resolvingAgainstBaseURL: false))
        parts.fragment = "fixture"
        let coordinator = WebCanvasCoordinator(state: state, appearance: appearance, entryURL: parts.url)
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(coordinator, name: WebCanvasCoordinator.bridgeName)
        configuration.userContentController.addUserScript(WKUserScript(
            source: """
            window.canvasTestErrors = [];
            window.addEventListener('error', event => {
              window.canvasTestErrors.push(event.message || event.target.src || 'resource error');
            }, true);
            window.addEventListener('unhandledrejection', event => {
              window.canvasTestErrors.push(String(event.reason));
            });
            """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1000, height: 700),
                                configuration: configuration)
        webView.navigationDelegate = coordinator
        let window = NSWindow(contentRect: webView.frame, styleMask: [.titled],
                              backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = webView
        window.orderFront(nil)
        defer {
            webView.stopLoading()
            coordinator.invalidateSession()
            configuration.userContentController.removeScriptMessageHandler(forName: "plotweaveHost")
            configuration.userContentController.removeScriptMessageHandler(
                forName: WebCanvasCoordinator.bridgeName
            )
            window.close()
        }
        coordinator.loadCanvas(into: webView)
        try await expectRenderedCanvas(state: state, webView: webView)

        // Retry is the failure overlay's recovery entry. Exercise an actual
        // second navigation, not only the state object's token increment.
        state.fail("Test load failure")
        state.retry()
        coordinator.reloadIfNeeded(into: webView)
        try await expectRenderedCanvas(state: state, webView: webView)
    }

    /// Waits for the production handshake, then checks executable content and CSS.
    private func expectRenderedCanvas(state: WebCanvasState, webView: WKWebView) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(17))
        while state.phase == .loading && ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(100))
        }
        let errors = try await webView.evaluateJavaScript("window.canvasTestErrors") as? [String]
        #expect(state.phase == .ready, "WebKit errors: \(String(describing: errors))")
        #expect(errors == [])
        let nodes = try await webView.evaluateJavaScript(
            "document.querySelectorAll('.react-flow__node').length"
        ) as? Int
        #expect(nodes == 9)
        let styledNodes = try await webView.evaluateJavaScript("""
            Array.from(document.querySelectorAll('.react-flow__node')).filter(node => {
              const style = getComputedStyle(node);
              return style.position === 'absolute' && style.visibility === 'visible'
                && node.getBoundingClientRect().width > 0;
            }).length
            """) as? Int
        #expect(styledNodes == 9)
    }
}
