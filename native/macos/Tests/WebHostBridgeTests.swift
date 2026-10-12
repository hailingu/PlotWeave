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

    /// A mutation arriving after quit delivery still blocks final approval, while explicit cancellation remains available.
    @Test func nativeMutationAfterQuitDeliveryBlocksApproval() async throws {
        let fixture = try WebFixture()
        defer { fixture.close() }
        try await fixture.waitUntilReady()
        let application = NativeApplicationState()
        application.connect(fixture.coordinator)
        var approvals = 0
        fixture.quit.onApproved = { _ in approvals += 1 }
        fixture.quit.acknowledgeListener()
        fixture.quit.request(.terminate)
        try await fixture.waitForQuitEvent()
        try await fixture.pauseNativeMutation(application)
        let exit = HostRequest(protocolVersion: 1, sessionId: fixture.coordinator.sessionId, requestId: "late-approval", command: "app_exit", args: nil)
        do {
            _ = try await fixture.services.perform(exit)
            Issue.record("最终批准不得忽略冲刷期间新增的原生意图")
        } catch let error as HostFailure { #expect(error.code == "PW_NATIVE_INTENTS_PENDING") }
        #expect(approvals == 0)
        #expect(fixture.quit.pendingIntent == .terminate)
        _ = try await fixture.services.perform(HostRequest(protocolVersion: 1, sessionId: exit.sessionId, requestId: "late-cancel", command: "app_exit", args: ["cancel": .bool(true)]))
        #expect(fixture.quit.pendingIntent == nil)
        _ = try await fixture.webView.evaluateJavaScript("window.releaseIntent(); null")
        _ = try await application.request("fixture.after")
        fixture.quit.request(.terminate)
        _ = try await fixture.services.perform(exit)
        #expect(approvals == 1)
    }

    /// Cancelling an exit during native admission must not deliver a stale quit after the mutation completes.
    @Test func cancelledQuitCannotReplayAfterNativeDrain() async throws {
        let fixture = try WebFixture()
        defer { fixture.close() }
        try await fixture.waitUntilReady()
        let application = NativeApplicationState()
        application.connect(fixture.coordinator)
        try await fixture.pauseNativeMutation(application)
        let drain = fixture.coordinator.drainNativeIntents
        var waiting = false
        fixture.coordinator.drainNativeIntents = { waiting = true; try await drain?() }
        let deliver = fixture.quit.sendEvent
        var settled = false
        fixture.quit.sendEvent = { name, payload in
            defer { settled = true }
            try await deliver?(name, payload)
        }
        fixture.quit.acknowledgeListener()
        fixture.quit.request(.terminate)
        try await fixture.wait { waiting }
        fixture.quit.cancel()
        _ = try await fixture.webView.evaluateJavaScript("window.releaseIntent(); null")
        try await fixture.wait { settled }
        #expect(try await fixture.webView.evaluateJavaScript("window.quitEvents") as? Int == 0)
        #expect(fixture.quit.pendingIntent == nil)
        _ = try await application.request("fixture.after")
    }

    /// Delivered quit events lose authority on every page failure, and recovery needs a new explicit user intent.
    @Test(arguments: ["process", "load", "provisional", "detach"], [true, false])
    func pageFailureSettlesPendingQuit(failure: String, listenerReady: Bool) async throws {
        let fixture = try WebFixture()
        defer { fixture.close() }
        try await fixture.waitUntilReady()
        var replies: [Bool] = []
        let delegate = NativeApplicationDelegate(quit: fixture.quit, terminateApplication: {}, replyToTermination: { replies.append($0) })
        delegate.applicationDidFinishLaunching(Notification(name: NSApplication.didFinishLaunchingNotification))
        if listenerReady { fixture.quit.acknowledgeListener() }
        #expect(delegate.applicationShouldTerminate(NSApplication.shared) == (listenerReady ? .terminateLater : .terminateCancel))
        if listenerReady { try await fixture.waitForQuitEvent() }
        switch failure {
        case "process": fixture.coordinator.webViewWebContentProcessDidTerminate(fixture.webView)
        case "load": fixture.coordinator.webView(fixture.webView, didFail: nil, withError: URLError(.networkConnectionLost))
        case "provisional": fixture.coordinator.webView(fixture.webView, didFailProvisionalNavigation: nil, withError: URLError(.cannotFindHost))
        default: fixture.coordinator.invalidateSession()
        }
        #expect(replies == (listenerReady ? [false] : []))
        #expect(fixture.quit.pendingIntent == nil)
        #expect(!fixture.quit.listenerReady)
        #expect(throws: HostFailure.self) { try fixture.quit.approve() }
        fixture.coordinator.invalidateSession()
        #expect(replies == (listenerReady ? [false] : []))
        fixture.state.retry()
        fixture.coordinator.reloadIfNeeded(into: fixture.webView)
        try await fixture.waitUntilReady()
        fixture.quit.acknowledgeListener()
        #expect(fixture.quit.pendingIntent == nil)
        #expect(replies == (listenerReady ? [false] : []))
        #expect(delegate.applicationShouldTerminate(NSApplication.shared) == .terminateLater)
        try fixture.quit.approve()
        #expect(replies == (listenerReady ? [false, true] : [true]))
    }

    /// A late crash from the replaced page cannot reject the replacement's current deferred decision.
    @Test func oldPageFailureCannotCancelReplacementQuit() async throws {
        let old = try WebFixture()
        defer { old.close() }
        try await old.waitUntilReady()
        let current = try WebFixture(services: old.services)
        defer { current.close() }
        try await current.waitUntilReady()
        var replies: [Bool] = []
        let delegate = NativeApplicationDelegate(quit: current.quit, terminateApplication: {}, replyToTermination: { replies.append($0) })
        delegate.applicationDidFinishLaunching(Notification(name: NSApplication.didFinishLaunchingNotification))
        current.quit.acknowledgeListener()
        #expect(delegate.applicationShouldTerminate(NSApplication.shared) == .terminateLater)
        try await current.waitForQuitEvent()
        old.coordinator.webViewWebContentProcessDidTerminate(old.webView)
        #expect(current.quit.pendingIntent == .terminate && current.quit.listenerReady)
        #expect(replies.isEmpty)
        try current.quit.approve()
        #expect(replies == [true])
    }

    /// Host-selected temporary HTML keeps trust tests independent of app resources and real data roots.
    @MainActor
    private final class WebFixture {
        let root: URL
        let webView: WKWebView
        let coordinator: WebCanvasCoordinator
        /// Replacement pages share a service only when a test explicitly selects that lifecycle boundary.
        let services: NativeHostServices
        /// Quit authority stays with the service's one controller, independent of fixture page identity.
        var quit: HostQuitController { services.quit }
        let state = WebCanvasState()
        private let projectionLog: ProjectionLog
        var projections: [[String: Any]] { projectionLog.values }

        /// Shared observer state contains only the projection values delivered on the UI actor.
        @MainActor private final class ProjectionLog {
            var values: [[String: Any]] = []
        }

        /// Installs a real reply-capable bridge on a page containing only the versioned test contracts.
        init(services: NativeHostServices? = nil) throws {
            self.services = services ?? NativeHostServices(dataRoot: nil, quit: HostQuitController())
            root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-web-host-" + UUID().uuidString)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            let entry = root.appendingPathComponent("bridge.html")
            try Data("""
                <!doctype html><script>
                window.intentCalls = 0;
                window.quitEvents = 0;
                window.__pwDispatchHostEvent = name => { if (name === 'app-quit-requested') window.quitEvents++; };
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
                services: self.services,
                onProjection: { body in log.values.append(body) }
            )
            configuration.userContentController.add(coordinator, name: WebCanvasCoordinator.bridgeName)
            webView.navigationDelegate = coordinator
            coordinator.loadCanvas(into: webView)
        }

        /// A synthetic native request remains inside the real WK promise until this fixture explicitly releases it.
        func pauseNativeMutation(_ application: NativeApplicationState) async throws {
            _ = try await webView.evaluateJavaScript("""
                const original = window.__pwNativeIntent;
                window.__pwNativeIntent = async request => {
                  if (request.command === 'fixture.mutate') await new Promise(resolve => window.releaseIntent = resolve);
                  return original(request);
                }; null
                """)
            application.send("fixture.mutate")
            let deadline = ContinuousClock.now.advanced(by: .seconds(5))
            while try await webView.evaluateJavaScript("typeof window.releaseIntent") as? String != "function", ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(20))
            }
            try #require(try await webView.evaluateJavaScript("typeof window.releaseIntent") as? String == "function")
        }

        /// Bounded native-state waits observe entry and completion of the actual owned delivery task.
        func wait(_ predicate: () -> Bool) async throws {
            let deadline = ContinuousClock.now.advanced(by: .seconds(5))
            while !predicate() && ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
            try #require(predicate())
        }

        /// Observes the actual script handshake rather than treating navigation completion as readiness.
        func waitUntilReady() async throws {
            let deadline = ContinuousClock.now.advanced(by: .seconds(5))
            while state.phase == .loading && ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(20))
            }
            #expect(state.phase == .ready)
        }

        /// The real page must receive the quit event before a simulated content-process failure can strand it.
        func waitForQuitEvent() async throws {
            let deadline = ContinuousClock.now.advanced(by: .seconds(5))
            while ContinuousClock.now < deadline {
                if try await webView.evaluateJavaScript("window.quitEvents") as? Int == 1 { return }
                try await Task.sleep(for: .milliseconds(20))
            }
            throw HostFailure(code: "PW_TEST_QUIT_EVENT_TIMEOUT", message: "隔离页面未收到退出事件")
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
