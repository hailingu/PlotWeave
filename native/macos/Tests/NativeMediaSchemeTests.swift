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

    /// Missing media returns one fixed public body rather than arbitrary service error details.
    @Test func unavailableMediaReturnsConstant404() async throws {
        let handler = NativeMediaScheme(loader: { _ in throw HostFailure(code: "PRIVATE_PATH", message: "/tmp/private-user-data") })
        let task = SchemeTask(url: try #require(URL(string: "pwmedia://localhost/library/a")))
        handler.webView(try IsolatedWebViewFixture.makeWebView(), start: task)
        for _ in 0..<100 where task.terminals == 0 { try await Task.sleep(for: .milliseconds(5)) }
        #expect(task.status == 404)
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
        var status: Int?
        var bytes = Data()
        var finished = 0
        var failed = 0
        var terminals: Int { finished + failed }
        init(url: URL) { request = URLRequest(url: url) }
        func didReceive(_ response: URLResponse) { status = (response as? HTTPURLResponse)?.statusCode }
        func didReceive(_ data: Data) { bytes.append(data) }
        func didFinish() { finished += 1 }
        func didFailWithError(_ error: any Error) { failed += 1 }
    }
}
