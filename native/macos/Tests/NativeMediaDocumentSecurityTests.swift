import AppKit
import Foundation
import Testing
import WebKit
@testable import PlotWeaveNative

/// Actual WK navigation proves policy enforcement; the control proves scripting is enabled in the same engine.
@MainActor
@Suite(.serialized, WebKitTestIsolation())
struct NativeMediaDocumentSecurityTests {
    /// SVG keeps its image MIME and styles but cannot gain document scripting when navigated directly.
    @Test func svgDocumentCannotExecuteScripts() async throws {
        let control = try await page(control: true)
        #expect(control["executed"] == "yes", "The positive control must execute before judging the guarded document")
        let guarded = try await page()
        #expect(guarded["root"] == "svg" && guarded["fixture"] == "ready")
        #expect(guarded["fill"] == "rgb(12, 34, 56)")
        #expect(guarded["executed"] == "", "A navigated media document executed its own script")
    }

    /// The ordinary image consumer still decodes the SVG after media response hardening.
    @Test func styledSvgStillDecodesAsImage() async throws {
        let image = try await page(image: true)
        #expect(image["width"] == "8" && image["height"] == "8")
    }

    /// Own one real descriptor, scheme, window and navigation receipt for the entire awaited operation.
    private func page(control: Bool = false, image: Bool = false) async throws -> [String: String] {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-media-document-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let directory = try NativeDirectory(root: root)
        let payload = Data(Self.svg.utf8)
        try directory.write(payload, name: "fixture.svg")
        let file = try NativeMediaFile(descriptor: directory.openFile("fixture.svg"), mime: "image/svg+xml")
        let gate = NativeMediaReadGate(limit: 1)
        let handler: any WKURLSchemeHandler
        if control { handler = ScriptControlScheme(payload: payload) }
        else { handler = NativeMediaScheme(loader: { _ in (file, 10_000) }, gate: gate) }
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.setURLSchemeHandler(handler, forURLScheme: "pwmedia")
        let view = try IsolatedWebViewFixture.makeWebView(frame: NSRect(x: 0, y: 0, width: 320, height: 200), configuration: configuration)
        let receipt = NavigationReceipt()
        view.navigationDelegate = receipt
        let window = NSWindow(contentRect: view.frame, styleMask: .borderless, backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = view
        window.orderFront(nil)
        defer {
            view.stopLoading()
            view.navigationDelegate = nil
            (handler as? NativeMediaScheme)?.cancelAll()
            window.close()
        }
        let url = try #require(URL(string: "pwmedia://localhost/library/fixture"))
        if image { view.loadHTMLString("<!doctype html><img id='fixture' src='\(url.absoluteString)'>", baseURL: nil) }
        else { view.load(URLRequest(url: url)) }
        try await receipt.wait()
        if image { return try await imageSnapshot(view) }
        let value = try await view.callAsyncJavaScript("return {root: document.documentElement.localName, fixture: document.documentElement.getAttribute('data-fixture'), executed: document.documentElement.getAttribute('data-executed') || '', fill: getComputedStyle(document.querySelector('rect')).fill};", arguments: [:], in: nil, contentWorld: .defaultClient)
        return try #require(value as? [String: String])
    }

    /// Completion and decoded dimensions form a real resource receipt instead of a fixed delay.
    private func imageSnapshot(_ view: WKWebView) async throws -> [String: String] {
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while ContinuousClock.now < deadline {
            let value = try await view.callAsyncJavaScript("const image = document.getElementById('fixture'); return {complete: String(image.complete), width: String(image.naturalWidth), height: String(image.naturalHeight)};", arguments: [:], in: nil, contentWorld: .defaultClient)
            let result = try #require(value as? [String: String])
            if result["complete"] == "true" { return result }
            try await Task.sleep(for: .milliseconds(20))
        }
        throw HostFailure(code: "PW_TEST_IMAGE_TIMEOUT", message: "Owned SVG image did not finish decoding")
    }

    /// A styled, self-contained payload can report scripting only by executing its actual SVG script.
    private static let svg = """
    <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" data-fixture="ready">
      <style>rect { fill: rgb(12, 34, 56); }</style><rect width="8" height="8"/>
      <script>document.documentElement.setAttribute('data-executed', 'yes');</script>
    </svg>
    """

    /// Only the positive control omits response policy; it shares the same bytes and real WebKit engine.
    private final class ScriptControlScheme: NSObject, WKURLSchemeHandler {
        /// Owned synthetic SVG never reads a user file or reaches the network.
        let payload: Data
        /// The immutable control response remains alive through synchronous delivery.
        init(payload: Data) { self.payload = payload }
        /// Deliver a real unsandboxed SVG response so a disabled scripting environment cannot pass vacuously.
        func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
            guard let url = task.request.url, let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "image/svg+xml"]) else {
                task.didFailWithError(URLError(.badURL)); return
            }
            task.didReceive(response)
            task.didReceive(payload)
            task.didFinish()
        }
        /// The control owns no background work after its synchronous callbacks.
        func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {}
    }

    /// Both success and failure settle a bounded navigation receipt with the real WebKit outcome.
    private final class NavigationReceipt: NSObject, WKNavigationDelegate {
        /// Completion is delivered by WebKit, never inferred from an arbitrary elapsed delay.
        private var completed = false
        /// A policy or process error must fail the test rather than look like a safe empty page.
        private var failure: (any Error)?
        /// Wait only for this fixture's navigation and preserve the actual failure cause.
        func wait() async throws {
            let deadline = ContinuousClock.now.advanced(by: .seconds(10))
            while !completed, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
            guard completed else { throw HostFailure(code: "PW_TEST_NAVIGATION_TIMEOUT", message: "Owned media navigation did not finish") }
            if let failure { throw failure }
        }
        /// A successful callback proves that the requested document actually reached its final load state.
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { completed = true }
        /// Failed committed navigation retains WebKit's original error for diagnosis.
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) { failure = error; completed = true }
        /// Failed provisional navigation cannot masquerade as a script-blocking success.
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) { failure = error; completed = true }
    }
}
