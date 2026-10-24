import AppKit
import CryptoKit
import Testing
import WebKit
@testable import PlotWeaveNative

/// Real WK transport measures the production File facade against an isolated native service root.
@MainActor
@Suite(.serialized, WebKitTestIsolation())
struct WebLibraryImportTests {
    /// Legal large BMPs must commit identical bytes while page timers and animation frames advance.
    @Test func largeImportsRecordResponsivenessAndExactMedia() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-web-upload-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let entry = root.appendingPathComponent("probe.html")
        try Data("<html><body>Library import probe</body></html>".utf8).write(to: entry)
        let state = WebCanvasState()
        let services = NativeHostServices(dataRoot: root.appendingPathComponent("data"), quit: HostQuitController())
        let coordinator = WebCanvasCoordinator(state: state, appearance: CanvasAppearanceState(), entryURL: entry, services: services)
        let configuration = WKWebViewConfiguration()
        let web = try IsolatedWebViewFixture.makeWebView(frame: NSRect(x: 0, y: 0, width: 800, height: 600), configuration: configuration)
        configuration.userContentController.add(coordinator, name: WebCanvasCoordinator.bridgeName)
        web.navigationDelegate = coordinator
        let window = NSWindow(contentRect: web.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = web
        window.orderFront(nil)
        defer {
            web.stopLoading(); coordinator.invalidateSession()
            configuration.userContentController.removeScriptMessageHandler(forName: "plotweaveHost")
            configuration.userContentController.removeScriptMessageHandler(forName: WebCanvasCoordinator.bridgeName)
            window.close()
        }
        coordinator.loadCanvas(into: web)
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while ContinuousClock.now < deadline {
            if !web.isLoading, (try? await web.evaluateJavaScript("window.__pwNativeHost?.sessionId")) as? String == coordinator.sessionId { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        let probe = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("build/library-import-probe.js")
        _ = try await web.evaluateJavaScript(String(contentsOf: probe, encoding: .utf8))
        _ = try await web.callAsyncJavaScript("return await PlotWeaveLibraryProbe.verifyFailureRecovery()", arguments: [:], in: nil, contentWorld: .page)
        for size in [10, 20] {
            let raw = try await web.callAsyncJavaScript("return await PlotWeaveLibraryProbe.measure(size)", arguments: ["size": size], in: nil, contentWorld: .page)
            let value = try #require(raw)
            let result = try HostJSON(webValue: value)
            let relative = try #require(result["asset"]?["relPath"]?.string)
            let bytes = try Data(contentsOf: root.appendingPathComponent("data/library/" + relative))
            #expect(bytes.count == Int(try #require(result["bytes"]?.number)))
            #expect(SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() == result["sha256"]?.string)
            #expect((result["ticks"]?.number ?? 0) > 1)
            #expect((result["frames"]?.number ?? 0) > 0)
            #expect((result["maxTimerGapMs"]?.number ?? .infinity) < 1000)
            print("PW-LIBRARY-PROBE host=swift result=\(String(decoding: try JSONEncoder().encode(result), as: UTF8.self))")
        }
    }
}
