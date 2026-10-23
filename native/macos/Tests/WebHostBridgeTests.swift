import AppKit
import Testing
import WebKit
@testable import PlotWeaveNative

/// Real WebKit exercises session trust and projection/intent invalidation at their host entry points.
@MainActor
@Suite(.serialized, WebKitTestIsolation())
struct WebHostBridgeTests {
    /// Same-URL messages must prove the current document identity before cancelling its deadline.
    @Test func readyHandshakeRequiresCurrentProtocolSession() async throws {
        let fixture = try WebFixture(automaticallyReady: false)
        defer { fixture.close() }
        try await fixture.waitForCurrentDocument(requiresReady: false)
        let oldSession = fixture.coordinator.sessionId
        fixture.state.retry()
        fixture.coordinator.reloadIfNeeded(into: fixture.webView)
        try await fixture.waitForCurrentDocument(requiresReady: false)
        let session = fixture.coordinator.sessionId
        let invalid: [[String: Any]] = [
            ["event": "ready"],
            ["event": "ready", "protocolVersion": 2, "sessionId": session],
            ["event": "ready", "protocolVersion": 1],
            ["event": "ready", "protocolVersion": 1, "sessionId": oldSession]
        ]
        for (index, body) in invalid.enumerated() {
            try await fixture.sendReady(body, sequence: index)
            #expect(fixture.state.phase == .loading)
        }
        do {
            _ = try await fixture.coordinator.sendNativeIntent(request: ["command": "fixture.beforeReady"])
            Issue.record("Invalid readiness authorized a native intent")
        } catch let error as HostFailure { #expect(error.code == "PW_CANVAS_NOT_READY") }
        try await fixture.sendReady(["event": "ready", "protocolVersion": 1, "sessionId": session], sequence: 10)
        #expect(fixture.state.phase == .ready)
        _ = try await fixture.coordinator.sendNativeIntent(request: ["command": "fixture.afterReady"])
        #expect(try await fixture.webView.evaluateJavaScript("window.intentCalls") as? Int == 1)
    }

    /// An earlier replacement cannot suppress the final retry's real ready timeout.
    @Test func staleReadyPreservesReplacementDeadline() async throws {
        let fixture = try WebFixture(automaticallyReady: false)
        defer { fixture.close() }
        try await fixture.waitForCurrentDocument(requiresReady: false)
        fixture.state.fail("isolated initial failure")
        fixture.state.retry()
        fixture.coordinator.reloadIfNeeded(into: fixture.webView)
        try await fixture.waitForCurrentDocument(requiresReady: false)
        let replaced = fixture.coordinator.sessionId
        fixture.state.retry()
        fixture.coordinator.reloadIfNeeded(into: fixture.webView)
        try await fixture.waitForCurrentDocument(requiresReady: false)
        try await fixture.sendReady(["event": "ready", "protocolVersion": 1, "sessionId": replaced], sequence: 20)
        try #require(fixture.state.phase == .loading)
        try await fixture.wait(timeout: .seconds(17)) { fixture.state.phase != .loading }
        if case .failed = fixture.state.phase { } else { Issue.record("Replacement deadline was cancelled by stale ready") }
        #expect(fixture.quit.canvasUnavailable)
    }

    /// A superseded WebKit navigation cannot invalidate the selected document, before or after its handshake.
    @Test(arguments: ["load", "provisional"], [false, true])
    func staleNavigationFailurePreservesCurrentDocument(kind: String, ready: Bool) async throws {
        let fixture = try WebFixture(automaticallyReady: false)
        defer { fixture.close() }
        try await fixture.waitForCurrentDocument(requiresReady: false)
        let entry = fixture.root.appendingPathComponent("bridge.html")
        let replaced = try #require(fixture.webView.loadFileURL(entry, allowingReadAccessTo: fixture.root))
        fixture.coordinator.loadCanvas(into: fixture.webView)
        try await fixture.waitForCurrentDocument(requiresReady: false)
        if ready {
            try await fixture.sendReady(["event": "ready", "protocolVersion": 1,
                                         "sessionId": fixture.coordinator.sessionId], sequence: 30)
        }
        if kind == "load" {
            fixture.coordinator.webView(fixture.webView, didFail: replaced, withError: URLError(.networkConnectionLost))
        } else {
            fixture.coordinator.webView(fixture.webView, didFailProvisionalNavigation: replaced, withError: URLError(.cancelled))
        }
        #expect(fixture.state.phase == (ready ? .ready : .loading))
        #expect(!fixture.quit.canvasUnavailable)
    }

    /// A retained view must revoke the old document's readiness before any new-page native intent.
    @Test func reloadingReadyCanvasWaitsForFreshHandshake() async throws {
        let fixture = try WebFixture()
        defer { fixture.close() }
        try await fixture.waitUntilReady()
        let token = fixture.state.reloadToken
        fixture.coordinator.loadCanvas(into: fixture.webView)
        try #require(fixture.state.phase == .loading)
        #expect(fixture.state.reloadToken == token)
        do {
            _ = try await fixture.coordinator.sendNativeIntent(request: ["command": "fixture.beforeReady"])
            Issue.record("Reload accepted a native intent before the fresh handshake")
        } catch let error as HostFailure {
            #expect(error.code == "PW_CANVAS_NOT_READY")
        }
        try await fixture.waitForCurrentDocument()
        try await fixture.waitUntilReady()
        _ = try await fixture.coordinator.sendNativeIntent(request: ["command": "fixture.afterReady"])
        #expect(try await fixture.webView.evaluateJavaScript("window.intentCalls") as? Int == 1)
    }

    /// ErrorBoundary's real page reload must retire readiness and require the replacement document's session.
    @Test func pageReloadRequiresFreshHandshake() async throws {
        let fixture = try WebFixture(automaticallyReady: false)
        defer { fixture.close() }
        try await fixture.waitForCurrentDocument(requiresReady: false)
        let previous = fixture.coordinator.sessionId
        try await fixture.sendReady(["event": "ready", "protocolVersion": 1, "sessionId": previous], sequence: 40)
        try await fixture.reloadFromPage()
        #expect(fixture.coordinator.sessionId != previous)
        #expect(fixture.state.phase == .loading)
        do {
            _ = try await fixture.coordinator.sendNativeIntent(request: ["command": "fixture.beforeReady"])
            Issue.record("Page reload retained permission to send native intents")
        } catch let error as HostFailure { #expect(error.code == "PW_CANVAS_NOT_READY") }
        try await fixture.sendReady(["event": "ready", "protocolVersion": 1, "sessionId": previous], sequence: 41)
        #expect(fixture.state.phase == .loading)
        try await fixture.sendReady(["event": "ready", "protocolVersion": 1,
                                     "sessionId": fixture.coordinator.sessionId], sequence: 42)
        #expect(fixture.state.phase == .ready)
        _ = try await fixture.coordinator.sendNativeIntent(request: ["command": "fixture.afterReady"])
        #expect(try await fixture.webView.evaluateJavaScript("window.intentCalls") as? Int == 1)
    }

    /// Failures of the real replacement navigation must surface and recover through the existing native retry.
    @Test(arguments: ["load", "provisional"])
    func pageReloadFailureRevokesReadyAndCanRetry(kind: String) async throws {
        let fixture = try WebFixture()
        defer { fixture.close() }
        try await fixture.waitUntilReady()
        let observer = NavigationObserver(coordinator: fixture.coordinator)
        defer { withExtendedLifetime(observer) {} }
        fixture.webView.navigationDelegate = observer
        _ = try await fixture.webView.evaluateJavaScript("setTimeout(() => window.location.reload(), 0); null")
        try await fixture.wait { observer.navigation != nil }
        let navigation = try #require(observer.navigation)
        if kind == "load" {
            fixture.coordinator.webView(fixture.webView, didFail: navigation, withError: URLError(.networkConnectionLost))
        } else {
            fixture.coordinator.webView(fixture.webView, didFailProvisionalNavigation: navigation, withError: URLError(.cannotFindHost))
        }
        guard case .failed = fixture.state.phase else {
            Issue.record("Page reload failure did not surface a failed canvas")
            return
        }
        #expect(fixture.quit.canvasUnavailable)
        do {
            _ = try await fixture.coordinator.sendNativeIntent(request: ["command": "fixture.failed"])
            Issue.record("Failed page reload accepted a native intent")
        } catch let error as HostFailure { #expect(error.code == "PW_STALE_SESSION") }
        fixture.state.retry()
        fixture.coordinator.reloadIfNeeded(into: fixture.webView)
        try await fixture.waitForCurrentDocument()
        try await fixture.waitUntilReady()
        _ = try await fixture.coordinator.sendNativeIntent(request: ["command": "fixture.recovered"])
        #expect(try await fixture.webView.evaluateJavaScript("window.intentCalls") as? Int == 1)
    }

    /// Native identities belong to the retained page, survive application-state reconnects, and reset only on real reload.
    @Test func nativeIntentIdentityUsesCurrentPageOrdinal() async throws {
        let fixture = try WebFixture()
        defer { fixture.close() }
        try await fixture.waitUntilReady()
        try await fixture.recordNativeIds()
        let first = NativeApplicationState()
        first.connect(fixture.coordinator)
        _ = try await first.request("fixture.first")
        let reconnected = NativeApplicationState()
        reconnected.connect(fixture.coordinator)
        _ = try await reconnected.request("fixture.second")
        #expect(try await fixture.webView.evaluateJavaScript("window.nativeIds") as? [String] == ["native:1", "native:2"])
        let previousSession = fixture.coordinator.sessionId
        fixture.coordinator.loadCanvas(into: fixture.webView)
        try await fixture.waitForCurrentDocument()
        #expect(fixture.coordinator.sessionId != previousSession)
        try await fixture.recordNativeIds()
        reconnected.connect(fixture.coordinator)
        _ = try await reconnected.request("fixture.reloaded")
        #expect(try await fixture.webView.evaluateJavaScript("window.nativeIds") as? [String] == ["native:1"])
    }

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

    /// Delivered quit events surface a visible degraded decision on page failure; cancelling keeps the app interactive
    /// and recovery requires a new explicit user intent.
    @Test(arguments: ["process", "load", "provisional", "detach"], [true, false])
    func pageFailureSettlesPendingQuit(failure: String, listenerReady: Bool) async throws {
        let fixture = try WebFixture()
        defer { fixture.close() }
        try await fixture.waitUntilReady()
        var replies: [Bool] = []
        var prompts: [HostQuitController.Intent] = []
        let delegate = NativeApplicationDelegate(
            quit: fixture.quit,
            terminateApplication: {},
            replyToTermination: { replies.append($0) },
            presentUnavailablePrompt: { intent in prompts.append(intent); return false }
        )
        delegate.applicationDidFinishLaunching(Notification(name: NSApplication.didFinishLaunchingNotification))
        if listenerReady { fixture.quit.acknowledgeListener() }
        #expect(delegate.applicationShouldTerminate(NSApplication.shared) == (listenerReady ? .terminateLater : .terminateCancel))
        if listenerReady { try await fixture.waitForQuitEvent() }
        switch failure {
        case "process": fixture.coordinator.webViewWebContentProcessDidTerminate(fixture.webView)
        case "load": fixture.coordinator.webView(fixture.webView, didFail: fixture.navigation, withError: URLError(.networkConnectionLost))
        case "provisional": fixture.coordinator.webView(fixture.webView, didFailProvisionalNavigation: fixture.navigation, withError: URLError(.cannotFindHost))
        default: fixture.coordinator.invalidateSession(canvasFailed: true)
        }
        // The visible degraded prompt refuses the exit; an already-deferred system decision receives its false reply.
        #expect(prompts == [.terminate])
        try await fixture.wait { fixture.quit.pendingIntent == nil }
        #expect(replies == (listenerReady ? [false] : []))
        #expect(!fixture.quit.listenerReady)
        #expect(fixture.quit.canvasUnavailable)
        #expect(throws: HostFailure.self) { try fixture.quit.approve() }
        fixture.coordinator.invalidateSession()
        #expect(replies == (listenerReady ? [false] : []))
        fixture.state.retry()
        fixture.coordinator.reloadIfNeeded(into: fixture.webView)
        try await fixture.waitUntilReady()
        fixture.quit.acknowledgeListener()
        #expect(fixture.quit.pendingIntent == nil)
        #expect(!fixture.quit.canvasUnavailable)
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

    /// Test-only observation records real selected navigations while preserving production policy and failures.
    @MainActor
    private final class NavigationObserver: NSObject, WKNavigationDelegate {
        /// The real coordinator remains the navigation and session authority.
        let coordinator: WebCanvasCoordinator
        /// WebKit supplies this identity after its actual main-frame provisional start.
        private(set) var navigation: WKNavigation?

        /// Observation never constructs a replacement WKWebView or chooses its navigation policy.
        init(coordinator: WebCanvasCoordinator) { self.coordinator = coordinator }

        /// Host policy still owns any replacement load and its document-start script.
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            await coordinator.webView(webView, decidePolicyFor: action)
        }

        /// Captures the actual identity instead of guessing it from a page URL or private state.
        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            self.navigation = navigation
        }

        /// Unexpected real load errors retain their production failure behavior.
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            coordinator.webView(webView, didFail: navigation, withError: error)
        }

        /// Unexpected provisional errors also remain owned by the production coordinator.
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            coordinator.webView(webView, didFailProvisionalNavigation: navigation, withError: error)
        }
    }

    /// Host-selected temporary HTML keeps trust tests independent of app resources and real data roots.
    @MainActor
    private final class WebFixture {
        let root: URL
        let webView: WKWebView
        let coordinator: WebCanvasCoordinator
        let navigation: WKNavigation?
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
        init(services: NativeHostServices? = nil, automaticallyReady: Bool = true) throws {
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
                if (\(automaticallyReady)) window.webkit.messageHandlers.canvasHost.postMessage({
                    event: 'ready', protocolVersion: 1, sessionId: window.__pwNativeHost.sessionId
                });
                </script>
                """.utf8).write(to: entry)
            let configuration = WKWebViewConfiguration()
            webView = try IsolatedWebViewFixture.makeWebView(frame: NSRect(x: 0, y: 0, width: 400, height: 300), configuration: configuration)
            let log = ProjectionLog()
            projectionLog = log
            coordinator = WebCanvasCoordinator(
                state: state, appearance: CanvasAppearanceState(), entryURL: entry,
                services: self.services,
                onProjection: { body in log.values.append(body) }
            )
            configuration.userContentController.add(coordinator, name: WebCanvasCoordinator.bridgeName)
            webView.navigationDelegate = coordinator
            navigation = coordinator.loadCanvas(into: webView)
        }

        /// Observes production native IDs through the actual page handler, without invoking any business service.
        func recordNativeIds() async throws {
            _ = try await webView.evaluateJavaScript("""
                window.nativeIds = [];
                (() => {
                  const original = window.__pwNativeIntent;
                  window.__pwNativeIntent = async request => {
                    window.nativeIds.push(request.requestId); return await original(request);
                  };
                })(); null
                """)
        }

        /// A document-local probe observes the actual reload, independently of the host session implementation.
        func reloadFromPage() async throws {
            _ = try await webView.evaluateJavaScript("window.__pwPreviousDocument = true; setTimeout(() => window.location.reload(), 0); null")
            let deadline = ContinuousClock.now.advanced(by: .seconds(5))
            while ContinuousClock.now < deadline {
                if !webView.isLoading,
                   (try? await webView.evaluateJavaScript("window.__pwPreviousDocument === undefined")) as? Bool == true { return }
                try await Task.sleep(for: .milliseconds(20))
            }
            throw HostFailure(code: "PW_TEST_DOCUMENT_TIMEOUT", message: "隔离页面未完成自身重载")
        }

        /// A direct coordinator reload must await the new document marker, rather than reuse the previous ready state.
        func waitForCurrentDocument(requiresReady: Bool = true) async throws {
            let deadline = ContinuousClock.now.advanced(by: .seconds(5))
            while ContinuousClock.now < deadline {
                let session = try await webView.evaluateJavaScript("window.__pwNativeHost?.sessionId") as? String
                if session == coordinator.sessionId, !webView.isLoading, (!requiresReady || state.phase == .ready),
                   try await webView.evaluateJavaScript("typeof window.__pwNativeIntent") as? String == "function" { return }
                try await Task.sleep(for: .milliseconds(20))
            }
            throw HostFailure(code: "PW_TEST_DOCUMENT_TIMEOUT", message: "隔离 WK 重载未进入当前页面")
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
        func wait(timeout: Duration = .seconds(5), _ predicate: () -> Bool) async throws {
            let deadline = ContinuousClock.now.advanced(by: timeout)
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

        /// A projection on the same channel acknowledges delivery after the synthetic ready envelope.
        func sendReady(_ body: [String: Any], sequence: Int) async throws {
            _ = try await webView.callAsyncJavaScript("""
                window.webkit.messageHandlers.canvasHost.postMessage(body);
                window.webkit.messageHandlers.canvasHost.postMessage(barrier);
                """, arguments: ["body": body, "barrier": [
                    "event": "projection", "protocolVersion": 1, "sessionId": coordinator.sessionId,
                    "sequence": sequence, "projection": ["route": "fixture"]
                ]], in: nil, contentWorld: .page)
            try await wait { self.projections.last?["sequence"] as? Int == sequence }
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
