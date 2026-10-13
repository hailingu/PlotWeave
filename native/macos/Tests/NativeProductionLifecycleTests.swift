import AppKit
import Foundation
import SwiftUI
import Testing
import WebKit
@testable import PlotWeaveNative

/// Production bundle, SwiftUI shell, Web canvas and native storage prove one document writer across real saves.
@MainActor
@Suite(.serialized)
struct NativeProductionLifecycleTests {
    /// Real canvas editing survives debounce, the quit fixed point and a second page opening the saved project.
    @Test func nativeProjectEditFlushAndReloadUsesActualIndependentStorage() async throws {
        let fixture = Fixture()
        defer { fixture.remove() }
        let projects = try #require(fixture.services.projectStore)
        let metadata = try await projects.invoke(command: "create_project", args: ["name": .string("原生真实业务")])
        let id = try #require(metadata["id"]?.string)
        let first = fixture.mount()
        try await wait { first.state.route == "home" && first.state.app["loading"] == .bool(false) }
        let webView = try #require(findWebView(first.window.contentView))
        try await waitForHostReady(webView)
        let identity = ObjectIdentifier(webView)
        _ = try await first.state.request("app.open", args: ["id": .string(id)])
        try await wait { first.state.route == "editor" && first.state.editor["projectId"]?.string == id }
        _ = try await first.state.request("editor.create", args: ["projectId": .string(id), "nodeType": .string("scene")])
        try await wait { first.state.editor["nodes"]?.arrayValue?.count == 1 }
        let node = try #require(first.state.editor["nodes"]?.arrayValue?.first?["id"]?.string)
        let patch: [String: HostJSON] = ["projectId": .string(id), "id": .string(node), "patch": .object(["synopsis": .string("防抖保存稿")])]
        _ = try await first.state.request("editor.patchNode", args: patch)
        try await waitForDisk(projects, id: id, node: node, synopsis: "防抖保存稿")
        #expect(ObjectIdentifier(try #require(findWebView(first.window.contentView))) == identity)
        let latest: [String: HostJSON] = ["projectId": .string(id), "id": .string(node), "patch": .object(["synopsis": .string("退出固定点稿")])]
        _ = try await first.state.request("editor.patchNode", args: latest)
        let approvals = ApprovalLog()
        fixture.quit.onApproved = { intent in
            if intent == .close { approvals.count += 1; first.window.close(); first.window.contentView = nil }
        }
        fixture.quit.request(.close)
        try await wait { approvals.count == 1 }
        let saved = try await projects.invoke(command: "load_project", args: ["id": .string(id)])
        #expect(saved["graph"]?["nodes"]?.arrayValue?.first { $0["id"]?.string == node }?["data"]?["spec"]?["synopsis"]?.string == "退出固定点稿")
        #expect(fixture.quit.pendingIntent == nil)
        let reopened = fixture.mount()
        try await wait { reopened.state.route == "home" && reopened.state.app["loading"] == .bool(false) }
        try await waitForHostReady(try #require(findWebView(reopened.window.contentView)))
        _ = try await reopened.state.request("app.open", args: ["id": .string(id)])
        try await wait { reopened.state.route == "editor" && reopened.state.editor["nodes"]?.arrayValue?.count == 1 }
        let exported = try await reopened.state.request("editor.exportPreview", args: ["projectId": .string(id), "format": .string("json")])
        let document = try JSONDecoder().decode(HostJSON.self, from: Data(try #require(exported["text"]?.string).utf8))
        #expect(document["graph"]?["nodes"]?.arrayValue?.first { $0["id"]?.string == node }?["data"]?["spec"]?["synopsis"]?.string == "退出固定点稿")
        await fixture.services.close()
    }

    /// A real failed project write preserves the editable window and latest draft until an explicit quit retry saves it.
    @Test func failedQuitSaveCanRecoverWithoutDeferredAppKitTermination() async throws {
        let fixture = Fixture()
        defer { fixture.remove() }
        let projects = try #require(fixture.services.projectStore)
        let metadata = try await projects.invoke(command: "create_project", args: ["name": .string("退出恢复")])
        let id = try #require(metadata["id"]?.string)
        let mounted = fixture.mount()
        try await wait { mounted.state.route == "home" && mounted.state.app["loading"] == .bool(false) }
        try await waitForHostReady(try #require(findWebView(mounted.window.contentView)))
        _ = try await mounted.state.request("app.open", args: ["id": .string(id)])
        try await wait { mounted.state.route == "editor" }
        let file = fixture.root.appendingPathComponent("projects/" + id + ".json")
        let backup = fixture.root.appendingPathComponent("projects/" + id + ".saved")
        try FileManager.default.moveItem(at: file, to: backup)
        try FileManager.default.createDirectory(at: file, withIntermediateDirectories: false)
        _ = try await mounted.state.request("editor.create", args: ["projectId": .string(id), "nodeType": .string("scene")])
        try await wait { mounted.state.editor["nodes"]?.arrayValue?.count == 1 }
        let approvals = ApprovalLog()
        var replies: [Bool] = []
        let delegate = NativeApplicationDelegate(quit: fixture.quit, terminateApplication: {}, replyToTermination: { approved in
            replies.append(approved)
            if approved { approvals.count += 1 }
        })
        delegate.applicationDidFinishLaunching(Notification(name: NSApplication.didFinishLaunchingNotification))
        #expect(delegate.applicationShouldTerminate(NSApplication.shared) == .terminateLater)
        // The Web error projection can arrive before its separate cancellation RPC settles AppKit.
        try await wait {
            mounted.state.app["error"]?.string?.contains("已阻止退出") == true
                && fixture.quit.pendingIntent == nil && replies == [false]
        }
        #expect(approvals.count == 0)
        #expect(mounted.window.isVisible)
        #expect(fixture.quit.pendingIntent == nil)
        #expect(replies == [false])
        try FileManager.default.removeItem(at: file)
        try FileManager.default.moveItem(at: backup, to: file)
        #expect(delegate.applicationShouldTerminate(NSApplication.shared) == .terminateLater)
        try await wait { approvals.count == 1 }
        #expect(replies == [false, true])
        #expect(delegate.applicationShouldTerminate(NSApplication.shared) == .terminateNow)
        let saved = try await projects.invoke(command: "load_project", args: ["id": .string(id)])
        #expect(saved["graph"]?["nodes"]?.arrayValue?.count == 1)
        #expect(mounted.state.app["error"] == .null)
        #expect(fixture.quit.pendingIntent == nil)
        await fixture.services.close()
    }

    /// A quit cannot outrun an admitted native mutation, including its asynchronous fingerprint and failed reply.
    @Test(arguments: ["bridge", "fingerprint", "failure"])
    func immediateQuitWaitsForNativeMutation(mode: String) async throws {
        let fixture = Fixture()
        defer { fixture.remove() }
        let projects = try #require(fixture.services.projectStore)
        let metadata = try await projects.invoke(command: "create_project", args: ["name": .string("原生意图退出")])
        let id = try #require(metadata["id"]?.string)
        let mounted = fixture.mount()
        try await wait { mounted.state.route == "home" && mounted.state.app["loading"] == .bool(false) }
        let webView = try #require(findWebView(mounted.window.contentView))
        try await waitForHostReady(webView)
        _ = try await mounted.state.request("app.open", args: ["id": .string(id)])
        try await wait { mounted.state.route == "editor" && mounted.state.projectId == id }
        _ = try await mounted.state.request("editor.create", args: ["projectId": .string(id), "nodeType": .string("scene")])
        try await wait { mounted.state.editor["nodes"]?.arrayValue?.count == 1 }
        let node = try #require(mounted.state.editor["nodes"]?.arrayValue?.first?["id"]?.string)
        try await installIntentGate(webView, mode: mode)
        var replies: [Bool] = []
        let delegate = NativeApplicationDelegate(quit: fixture.quit, terminateApplication: {}, replyToTermination: { replies.append($0) })
        delegate.applicationDidFinishLaunching(Notification(name: NSApplication.didFinishLaunchingNotification))
        mounted.state.sendEditor("editor.patchNode", args: ["id": .string(node), "patch": .object(["synopsis": .string("最后原生字段")])])
        #expect(delegate.applicationShouldTerminate(NSApplication.shared) == .terminateLater)
        try await waitForIntentGate(webView)
        // Observe a blocked future long enough for the old, empty Web save barrier to settle its quit.
        try await Task.sleep(for: .seconds(1))
        #expect(replies.isEmpty, "原生意图尚未落定，系统退出不得提前批准")
        #expect(fixture.quit.pendingIntent == .terminate)
        _ = try await webView.evaluateJavaScript("window.__pwIntentGate.release(); null")
        try await wait { replies == (mode == "failure" ? [false] : [true]) }
        if mode == "failure" {
            try await wait { mounted.state.error?.contains("PW_FIXTURE_INTENT_FAILURE") == true }
            #expect(mounted.window.isVisible)
            #expect(delegate.applicationShouldTerminate(NSApplication.shared) == .terminateLater)
            try await wait { replies == [false, true] }
        } else {
            let doc = try await projects.invoke(command: "load_project", args: ["id": .string(id)])
            #expect(doc["graph"]?["nodes"]?.arrayValue?.first { $0["id"]?.string == node }?["data"]?["spec"]?["synopsis"]?.string == "最后原生字段")
        }
        #expect(fixture.quit.pendingIntent == nil)
        await fixture.services.close()
    }

    /// The real browser delays exactly one synthetic edit either before admission or inside SHA-256 admission.
    private func installIntentGate(_ webView: WKWebView, mode: String) async throws {
        _ = try await webView.callAsyncJavaScript("""
            const original = window.__pwNativeIntent;
            const digest = crypto.subtle.digest.bind(crypto.subtle);
            let release;
            const gate = new Promise(resolve => release = resolve);
            window.__pwIntentGate = {entered: false, release};
            if (mode === 'fingerprint') {
              crypto.subtle.digest = async (...args) => {
                window.__pwIntentGate.entered = true;
                await gate;
                crypto.subtle.digest = digest;
                return digest(...args);
              };
            } else {
              window.__pwNativeIntent = async request => {
                if (request.command === 'editor.patchNode') {
                  window.__pwIntentGate.entered = true;
                  await gate;
                  window.__pwNativeIntent = original;
                  if (mode === 'failure') return {error: {code: 'PW_FIXTURE_INTENT_FAILURE', message: 'PW_FIXTURE_INTENT_FAILURE'}};
                }
                return original(request);
              };
            }
            return null;
            """, arguments: ["mode": mode], in: nil, contentWorld: .page)
    }

    /// Web keyboard mutations are saved before quitting; final approval cannot accept another undo.
    @Test(arguments: [false, true])
    func webFinalApprovalSealsCleanAndDrainedDocuments(dirty: Bool) async throws {
        let fixture = Fixture()
        defer { fixture.remove() }
        let projects = try #require(fixture.services.projectStore)
        let metadata = try await projects.invoke(command: "create_project", args: ["name": .string("Web 最终退出")])
        let id = try #require(metadata["id"]?.string)
        let mounted = fixture.mount()
        try await wait { mounted.state.route == "home" && mounted.state.app["loading"] == .bool(false) }
        let webView = try #require(findWebView(mounted.window.contentView))
        try await waitForHostReady(webView)
        _ = try await mounted.state.request("app.open", args: ["id": .string(id)])
        try await wait { mounted.state.route == "editor" }
        _ = try await mounted.state.request("editor.create", args: ["projectId": .string(id), "nodeType": .string("scene")])
        try await wait { mounted.state.editor["nodes"]?.arrayValue?.count == 1 }
        let node = try #require(mounted.state.editor["nodes"]?.arrayValue?.first?["id"]?.string)
        _ = try await mounted.state.request("editor.select", args: ["projectId": .string(id), "id": .string(node)])
        _ = try await mounted.state.request("editor.patchNode", args: ["projectId": .string(id), "id": .string(node), "patch": .object(["synopsis": .string("Web 基线稿")])])
        try await waitForDisk(projects, id: id, node: node, synopsis: "Web 基线稿")
        if dirty {
            // This genuine document keyboard event uses Web's command history, not a native intent.
            _ = try await webView.evaluateJavaScript("document.body.dispatchEvent(new KeyboardEvent('keydown', {key:'Delete', bubbles:true, cancelable:true})); null")
            try await wait { mounted.state.editor["nodes"]?.arrayValue?.count == 0 }
        }
        let gate = try installExitGate(webView)
        var approvals = 0
        fixture.quit.onApproved = { _ in approvals += 1 }
        fixture.quit.request(.close)
        try await wait { gate.entered }
        #expect(approvals == 0)
        #expect(try await webView.evaluateJavaScript("document.getElementById('root').inert") as? Bool == true)
        #expect(try await webView.evaluateJavaScript("document.body.dispatchEvent(new KeyboardEvent('keydown', {key:'z', ctrlKey:true, bubbles:true, cancelable:true}))") as? Bool == false)
        #expect(mounted.state.editor["nodes"]?.arrayValue?.count == (dirty ? 0 : 1))
        gate.release?()
        try await wait { approvals == 1 }
        let saved = try await projects.invoke(command: "load_project", args: ["id": .string(id)])
        #expect(saved["graph"]?["nodes"]?.arrayValue?.count == (dirty ? 0 : 1))
        #expect(fixture.quit.pendingIntent == nil)
        await fixture.services.close()
    }

    /// Holds only the final Web→Swift exit RPC, after the real Web fixed point has finished.
    private func installExitGate(_ webView: WKWebView) throws -> ExitMessageGate {
        let coordinator = try #require(webView.navigationDelegate as? WebCanvasCoordinator)
        let gate = ExitMessageGate(coordinator: coordinator)
        let controller = webView.configuration.userContentController
        controller.removeScriptMessageHandler(forName: "plotweaveHost", contentWorld: .page)
        controller.addScriptMessageHandler(gate, contentWorld: .page, name: "plotweaveHost")
        return gate
    }

    /// Delegates actual trusted WK messages unchanged; only final approval waits at a deterministic gate.
    @MainActor private final class ExitMessageGate: NSObject, WKScriptMessageHandlerWithReply {
        let coordinator: WebCanvasCoordinator
        var entered = false
        var release: (() -> Void)?
        /// Retains the real page coordinator through the held reply.
        init(coordinator: WebCanvasCoordinator) { self.coordinator = coordinator }
        /// Pauses approval before service dispatch, then forwards the same message and completion.
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
            let body = message.body as? [String: Any]
            let args = body?["args"] as? [String: Any]
            let forward = { self.coordinator.userContentController(controller, didReceive: message, replyHandler: replyHandler) }
            if body?["command"] as? String == "app_exit", args?["cancel"] as? Bool != true {
                entered = true
                release = { self.release = nil; forward() }
            } else { forward() }
        }
    }

    /// Gate admission is observed in the actual production page, never inferred from a submitted call.
    private func waitForIntentGate(_ webView: WKWebView) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(8))
        while ContinuousClock.now < deadline {
            if try await webView.evaluateJavaScript("window.__pwIntentGate.entered") as? Bool == true { return }
            try await Task.sleep(for: .milliseconds(30))
        }
        throw HostFailure(code: "PW_FIXTURE_GATE_TIMEOUT", message: "原生意图未进入确定性闸门")
    }

    /// Bounded polling observes actual state transitions and reports a useful last-state failure.
    private func wait(_ predicate: () -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(12))
        while !predicate() && ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(30)) }
        try #require(predicate(), "生产原生页面未在期限内完成业务状态转换")
    }

    /// Probes the real native ready guard without admitting a business intent.
    /// The version-rejection contract in src/platform/nativeShell.ts receiveIntent returns
    /// PW_INVALID_NATIVE_INTENT before handler lookup, replay caching or business execution.
    private func waitForHostReady(_ webView: WKWebView) async throws {
        let coordinator = try #require(webView.navigationDelegate as? WebCanvasCoordinator)
        let deadline = ContinuousClock.now.advanced(by: .seconds(12))
        while ContinuousClock.now < deadline {
            do {
                let response = try await coordinator.sendNativeIntent(request: [
                    "protocolVersion": 0, "sessionId": coordinator.sessionId,
                    "requestId": "readiness-probe", "command": "readiness.probe", "args": [:]
                ])
                let reply = try HostJSON(webValue: response)
                try #require(reply["error"]?["code"]?.string == "PW_INVALID_NATIVE_INTENT")
                return
            } catch let error as HostFailure where error.code == "PW_CANVAS_NOT_READY" {
                try await Task.sleep(for: .milliseconds(30))
            }
        }
        throw HostFailure(code: "PW_CANVAS_NOT_READY", message: "生产测试未在期限内观察到宿主就绪；" + readinessDiagnostics(webView))
    }

    /// Reports only fixture visibility and geometry when a real handshake times out.
    private func readinessDiagnostics(_ webView: WKWebView) -> String {
        guard let window = webView.window else { return "WKView 未附加窗口" }
        return "visible=\(window.isVisible), key=\(window.isKeyWindow), canKey=\(window.canBecomeKey), "
            + "active=\(NSApp.isActive), running=\(NSApp.isRunning), policy=\(NSApp.activationPolicy().rawValue), "
            + "occluded=\(!window.occlusionState.contains(.visible)), activeSpace=\(window.isOnActiveSpace), "
            + "frame=\(window.frame), screen=\(String(describing: window.screen?.frame)), layout=\(window.contentLayoutRect), "
            + "webFrame=\(webView.frame), webBounds=\(webView.bounds), visibleRect=\(webView.visibleRect), "
            + "hidden=\(webView.isHidden), alpha=\(webView.alphaValue)"
    }

    /// Actor reads verify persisted document bytes rather than a projection or mock save call.
    private func waitForDisk(_ projects: NativeProjectStore, id: String, node: String, synopsis: String) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(8))
        while ContinuousClock.now < deadline {
            let doc = try await projects.invoke(command: "load_project", args: ["id": .string(id)])
            if doc["graph"]?["nodes"]?.arrayValue?.first { $0["id"]?.string == node }?["data"]?["spec"]?["synopsis"]?.string == synopsis { return }
            try await Task.sleep(for: .milliseconds(40))
        }
        Issue.record("真实项目文件未保存原生编辑稿")
    }

    /// Finds the persistent canvas underneath the real SwiftUI composition without rebuilding it.
    private func findWebView(_ view: NSView?) -> WKWebView? {
        guard let view else { return nil }
        if let webView = view as? WKWebView { return webView }
        for child in view.subviews { if let result = findWebView(child) { return result } }
        return nil
    }

    /// A synchronous approval counter records the host's actual app_exit outcome.
    private final class ApprovalLog { var count = 0 }

    /// Every service/window belongs to this unique temporary root; default app-support paths are never selected.
    @MainActor private final class Fixture {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-native-production-" + UUID().uuidString)
        let quit = HostQuitController()
        let services: NativeHostServices
        private var windows: [NSWindow] = []

        /// Actor construction remains lazy until the fixture's explicit project request.
        init() { services = NativeHostServices(dataRoot: root, quit: quit) }

        /// Presents one actual native shell so WebKit can run the production frame-driven handshake.
        func mount() -> (window: NSWindow, state: NativeApplicationState) {
            let state = NativeApplicationState()
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 750), styleMask: [.titled], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            // Keep this disposable integration window visible above the foreground test client.
            window.level = .floating
            window.contentView = NSHostingView(rootView: NativeShellRoot(services: services, application: state))
            windows.append(window)
            window.contentView?.layoutSubtreeIfNeeded()
            // A nonactive app-hosted process still needs visible WebKit animation frames.
            window.orderFrontRegardless()
            return (window, state)
        }

        /// Teardown invalidates Web owners before removing only this fixture's disposable data.
        func remove() {
            for window in windows { window.close(); window.contentView = nil }
            try? FileManager.default.removeItem(at: root)
        }
    }
}
