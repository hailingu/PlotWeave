import AppKit
import Foundation
import Testing
import WebKit
@testable import PlotWeaveNative

/// The production file URL origin must provide cryptographic fingerprints without a weaker fallback.
@MainActor
struct NativeWebCryptoTests {
    /// Real WebKit hashes a synthetic request body under the same loadFileURL trust boundary as the app.
    @Test func localFilePageHasWebCryptoSHA256() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-web-crypto-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let entry = root.appendingPathComponent("crypto.html")
        try Data("<!doctype html><script>window.fixtureReady=true;</script>".utf8).write(to: entry)
        let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 100, height: 100))
        defer { webView.stopLoading(); try? FileManager.default.removeItem(at: root) }
        webView.loadFileURL(entry, allowingReadAccessTo: root)
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while ContinuousClock.now < deadline {
            if (try? await webView.evaluateJavaScript("window.fixtureReady === true")) as? Bool == true { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        let value = try await webView.callAsyncJavaScript("""
            const result = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('synthetic-request'));
            return Array.from(new Uint8Array(result)).length;
            """, arguments: [:], in: nil, contentWorld: .page)
        #expect(value as? Int == 32)
    }
}
