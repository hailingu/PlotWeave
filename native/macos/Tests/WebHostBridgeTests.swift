import AppKit
import Testing
import WebKit
@testable import PlotWeaveNative

/// Real WebKit exercises session trust and projection/intent invalidation at their host entry points.
@MainActor
struct WebHostBridgeTests {
    /// A dead page cannot publish a read projection or accept a native edit after crash/dismantle.
    @Test func invalidationStopsProjectionAndNativeIntents() async throws {
        let fixture = try WebFixture()
        defer { fixture.close() }
        try await fixture.waitUntilReady()
        try await fixture.sendProjection(sequence: 1)
        #expect(fixture.projections.count == 1)
        fixture.coordinator.invalidateSession()
        try await fixture.sendProjection(sequence: 2)
        #expect(fixture.projections.count == 1)
        do {
            _ = try await fixture.coordinator.sendNativeIntent(request: ["command": "editor.undo"])
            Issue.record("Invalidated session accepted a native edit")
        } catch let error as HostFailure {
            #expect(error.code == "PW_STALE_SESSION")
        }
        let calls = try await fixture.webView.evaluateJavaScript("window.intentCalls") as? Int
        #expect(calls == 0)
    }

    /// A reply handler installed for WebKit still rejects a child frame before any service call.
    @Test func childFrameCannotUseTrustedMainPageAuthority() async throws {
        let fixture = try WebFixture()
        defer { fixture.close() }
        try await fixture.waitUntilReady()
        let value = try await fixture.webView.callAsyncJavaScript("""
            const frame = document.createElement('iframe');
            document.body.append(frame);
            return await frame.contentWindow.webkit.messageHandlers.plotweaveHost.postMessage(request);
            """, arguments: ["request": [
                "protocolVersion": 1, "sessionId": fixture.coordinator.sessionId,
                "requestId": "child-frame", "command": "list_projects"
            ]], in: nil, contentWorld: .page)
        let reply = try HostJSON(webValue: try #require(value))
        #expect(reply["error"]?["code"]?.string == "PW_UNTRUSTED_FRAME")
    }

    /// Undefined action completion is a missing protocol reply, never a successful native command.
    @Test func undefinedNativeIntentReplyFailsVisibly() async throws {
        let fixture = try WebFixture()
        defer { fixture.close() }
        try await fixture.waitUntilReady()
        _ = try await fixture.webView.evaluateJavaScript("window.__pwNativeIntent = async () => undefined; null")
        do {
            _ = try await fixture.coordinator.sendNativeIntent(request: ["command": "editor.undo"])
            Issue.record("Native intent accepted a missing reply")
        } catch let error as HostFailure {
            #expect(error.code == "PW_INVALID_REPLY")
        }
    }

    /// Host-selected temporary HTML keeps trust tests independent of app resources and real data roots.
    @MainActor
    private final class WebFixture {
        let root: URL
        let webView: WKWebView
        let coordinator: WebCanvasCoordinator
        let state = WebCanvasState()
        private let projectionLog: ProjectionLog
        var projections: [[String: Any]] { projectionLog.values }

        /// Shared observer state contains only the projection values delivered on the UI actor.
        @MainActor private final class ProjectionLog {
            var values: [[String: Any]] = []
        }

        /// Installs a real reply-capable bridge on a page containing only the versioned test contracts.
        init() throws {
            root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-web-host-" + UUID().uuidString)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            let entry = root.appendingPathComponent("bridge.html")
            try Data("""
                <!doctype html><script>
                window.intentCalls = 0;
                window.__pwNativeIntent = async () => { window.intentCalls++; return {ok: null}; };
                window.webkit.messageHandlers.canvasHost.postMessage({event: 'ready'});
                </script>
                """.utf8).write(to: entry)
            let configuration = WKWebViewConfiguration()
            webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 400, height: 300), configuration: configuration)
            let log = ProjectionLog()
            projectionLog = log
            coordinator = WebCanvasCoordinator(
                state: state, appearance: CanvasAppearanceState(), entryURL: entry,
                services: NativeHostServices(dataRoot: nil, quit: HostQuitController()),
                onProjection: { body in log.values.append(body) }
            )
            configuration.userContentController.add(coordinator, name: WebCanvasCoordinator.bridgeName)
            webView.navigationDelegate = coordinator
            coordinator.loadCanvas(into: webView)
        }

        /// Observes the actual script handshake rather than treating navigation completion as readiness.
        func waitUntilReady() async throws {
            let deadline = ContinuousClock.now.advanced(by: .seconds(5))
            while state.phase == .loading && ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(20))
            }
            #expect(state.phase == .ready)
        }

        /// Sends the published protocol envelope through WebKit's real message-handler entry.
        func sendProjection(sequence: Int) async throws {
            _ = try await webView.callAsyncJavaScript(
                "window.webkit.messageHandlers.canvasHost.postMessage(body)",
                arguments: ["body": [
                    "event": "projection", "protocolVersion": 1, "sessionId": coordinator.sessionId,
                    "sequence": sequence, "projection": ["route": "editor", "projectId": "fixture"]
                ]], in: nil, contentWorld: .page
            )
            try await Task.sleep(for: .milliseconds(20))
        }

        /// Releases both handler ownerships before removing the disposable trusted page.
        func close() {
            webView.stopLoading()
            coordinator.invalidateSession()
            webView.configuration.userContentController.removeScriptMessageHandler(forName: "plotweaveHost")
            webView.configuration.userContentController.removeScriptMessageHandler(forName: WebCanvasCoordinator.bridgeName)
            try? FileManager.default.removeItem(at: root)
        }
    }
}
