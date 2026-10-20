import Foundation
import Testing
import WebKit
@testable import PlotWeaveNative

/// Scheme tests use owned temporary descriptors and a real WebKit task contract without user data or network.
@MainActor
@Suite(.serialized, WebKitTestIsolation())
struct NativeMediaSchemeTests {
    /// A bounded resource reaches response, byte chunks and exactly one successful completion.
    @Test func deliversOwnedMediaBytes() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-native-scheme-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let dir = try NativeDirectory(root: root)
        try dir.write(Data([1, 2, 3]), name: "image")
        let file = try NativeMediaFile(descriptor: dir.openFile("image"), mime: "image/png")
        let handler = NativeMediaScheme(loader: { _ in (file, 20) })
        let task = SchemeTask(url: try #require(URL(string: "pwmedia://localhost/library/a")))
        handler.webView(try IsolatedWebViewFixture.makeWebView(), start: task)
        for _ in 0..<100 where task.terminals == 0 { try await Task.sleep(for: .milliseconds(5)) }
        #expect(task.status == 200)
        #expect(task.bytes == Data([1, 2, 3]))
        #expect(task.finished == 1)
        #expect(task.failed == 0)
    }

    /// Response policy preserves media declarations and bytes while preventing document/script delivery.
    @Test func responsePolicyPreservesMediaAndRestrictsDocuments() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-native-response-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let dir = try NativeDirectory(root: root)
        let bytes = Data([1, 2, 3])
        try dir.write(bytes, name: "asset")
        let view = try IsolatedWebViewFixture.makeWebView()
        let cases = [("image/png", "image/png"), ("image/svg+xml", "image/svg+xml"), ("audio/mpeg", "audio/mpeg"), ("video/mp4", "video/mp4"),
                     ("text/html", "application/octet-stream"), ("application/xhtml+xml", "application/octet-stream"), ("application/pdf", "application/octet-stream"), ("image/png; charset=utf-8", "application/octet-stream"), ("Image/PNG", "application/octet-stream")]
        for (mime, expected) in cases {
            let file = try NativeMediaFile(descriptor: dir.openFile("asset"), mime: mime)
            let handler = NativeMediaScheme(loader: { _ in (file, 20) })
            let task = SchemeTask(url: try #require(URL(string: "pwmedia://localhost/library/a")))
            handler.webView(view, start: task)
            let deadline = ContinuousClock.now.advanced(by: .seconds(3))
            while task.terminals == 0, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(5)) }
            #expect(task.finished == 1 && task.failed == 0)
            #expect(task.bytes == bytes)
            #expect(task.response?.value(forHTTPHeaderField: "Content-Type") == expected, "\(mime)")
            #expect(task.response?.value(forHTTPHeaderField: "Content-Security-Policy") == "sandbox; script-src 'none'")
            #expect(task.response?.value(forHTTPHeaderField: "X-Content-Type-Options") == "nosniff")
        }
    }

    /// Missing media returns one fixed public body rather than arbitrary service error details.
    @Test func unavailableMediaReturnsConstant404() async throws {
        let handler = NativeMediaScheme(loader: { _ in throw HostFailure(code: "PRIVATE_PATH", message: "/tmp/private-user-data") })
        let task = SchemeTask(url: try #require(URL(string: "pwmedia://localhost/library/a")))
        handler.webView(try IsolatedWebViewFixture.makeWebView(), start: task)
        for _ in 0..<100 where task.terminals == 0 { try await Task.sleep(for: .milliseconds(5)) }
        #expect(task.status == 404)
        #expect(task.response?.value(forHTTPHeaderField: "Content-Type") == "text/plain; charset=utf-8")
        #expect(task.response?.value(forHTTPHeaderField: "Content-Security-Policy") == "sandbox; script-src 'none'")
        #expect(task.response?.value(forHTTPHeaderField: "X-Content-Type-Options") == "nosniff")
        #expect(String(data: task.bytes, encoding: .utf8) == "媒体不可用")
        #expect(task.finished == 1)
        #expect(task.failed == 0)
    }

    /// Stop during asynchronous resolution revokes every callback and returns capacity when the late result arrives.
    @Test func stoppedRequestIgnoresLateOpenedFileAndReturnsPermit() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-native-scheme-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let dir = try NativeDirectory(root: root)
        try dir.write(Data([1]), name: "image")
        let file = try NativeMediaFile(descriptor: dir.openFile("image"), mime: "image/png")
        let barrier = ResolutionBarrier()
        let gate = NativeMediaReadGate(limit: 1)
        let handler = NativeMediaScheme(loader: { _ in await barrier.wait(); return (file, 20) }, gate: gate)
        let task = SchemeTask(url: try #require(URL(string: "pwmedia://localhost/library/a")))
        let webView = try IsolatedWebViewFixture.makeWebView()
        handler.webView(webView, start: task)
        for _ in 0..<100 where await !barrier.started { try await Task.sleep(for: .milliseconds(5)) }
        #expect(await gate.occupancy() == 1)
        handler.webView(webView, stop: task)
        await barrier.finish()
        for _ in 0..<100 where await gate.occupancy() != 0 { try await Task.sleep(for: .milliseconds(5)) }
        #expect(task.status == nil)
        #expect(task.bytes.isEmpty)
        #expect(task.terminals == 0)
        #expect(await gate.occupancy() == 0)
    }

    /// A deterministic source delay reproduces late completion without timing a filesystem race.
    private actor ResolutionBarrier {
        private var continuation: CheckedContinuation<Void, Never>?
        private(set) var started = false
        func wait() async { await withCheckedContinuation { continuation = $0; started = true } }
        func finish() { continuation?.resume(); continuation = nil }
    }

    /// WebKit callback accounting detects duplicate completion independently of handler bookkeeping.
    private final class SchemeTask: NSObject, WKURLSchemeTask {
        let request: URLRequest
        /// The actual delivered headers are observable separately from callback completion.
        var response: HTTPURLResponse?
        var status: Int?
        var bytes = Data()
        var finished = 0
        var failed = 0
        var terminals: Int { finished + failed }
        init(url: URL) { request = URLRequest(url: url) }
        /// Capture the actual delivered headers and status independently of completion.
        func didReceive(_ response: URLResponse) { self.response = response as? HTTPURLResponse; status = self.response?.statusCode }
        func didReceive(_ data: Data) { bytes.append(data) }
        func didFinish() { finished += 1 }
        func didFailWithError(_ error: any Error) { failed += 1 }
    }
}
