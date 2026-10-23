import AppKit
import ApplicationServices
import SwiftUI
import Testing
import WebKit
@testable import PlotWeaveNative

/// Real composer controls preserve an unsent prompt when the native bridge rejects admission.
@MainActor
@Suite(.serialized, WebKitTestIsolation())
struct NativeAiDraftTests {
    /// A missing page has no Web user message, so its rejected send must leave the native draft intact.
    @Test func rejectedSendPreservesDraftAndAllowsRetry() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let editor = try await fixture.editor()
        fixture.enter("未发送的合成提示", in: editor)
        let send = try await fixture.sendButton()
        try #require(try NativeCreationControlFixture.isEnabled(send))
        // SwiftUI may report AX failure when the action synchronously disables its own button.
        // Actual admission failure below proves delivery; an undelivered action fails the bounded wait.
        _ = AXUIElementPerformAction(send, kAXPressAction as CFString)
        try await fixture.wait { fixture.state.error != nil }
        #expect(editor.string == "未发送的合成提示")
        let retry = try await fixture.sendButton()
        #expect(try NativeCreationControlFixture.isEnabled(retry))
    }

    /// A successful reply clears an unchanged submission, but cannot consume text typed meanwhile or in a remounted panel.
    @Test(arguments: ["unchanged", "changed", "remounted"])
    func acknowledgmentConsumesOnlySubmittedDraft(mode: String) async throws {
        let fixture = try Fixture(bridge: true)
        defer { fixture.remove() }
        let page = try #require(fixture.page)
        try await page.waitUntilReady()
        let editor = try await fixture.editor()
        fixture.enter("  合成提交稿  ", in: editor)
        _ = AXUIElementPerformAction(try await fixture.sendButton(), kAXPressAction as CFString)
        try await page.waitForSend(count: 1)
        #expect(editor.string == "  合成提交稿  ")
        #expect(!(try NativeCreationControlFixture.isEnabled(try await fixture.sendButton())))
        let current: NSTextView
        if mode == "remounted" { fixture.window.contentView = nil; fixture.mount(); current = try await fixture.editor() }
        else { current = editor }
        if mode != "unchanged" { fixture.enter("等待期间的新草稿", in: current) }
        try await page.completeSend()
        if mode == "unchanged" {
            try await fixture.wait { current.string.isEmpty }
        } else {
            _ = try await fixture.sendButton(enabled: true)
            #expect(current.string == "等待期间的新草稿")
        }
        #expect(try await page.webView.evaluateJavaScript("window.sent") as? [String] == ["合成提交稿"])
    }

    /// Web admission failures retain the prompt and an explicit retry uses the same visible text exactly once.
    @Test(arguments: ["PW_INTENT_UNAVAILABLE", "PW_INTENT_FAILED"])
    func rejectedWebAdmissionRetainsDraftUntilExplicitRetry(code: String) async throws {
        let fixture = try Fixture(bridge: true)
        defer { fixture.remove() }
        let page = try #require(fixture.page)
        try await page.waitUntilReady()
        let editor = try await fixture.editor()
        fixture.enter("合成失败重试稿", in: editor)
        _ = AXUIElementPerformAction(try await fixture.sendButton(), kAXPressAction as CFString)
        try await page.waitForSend(count: 1)
        try await page.completeSend(errorCode: code)
        try await fixture.wait { fixture.state.error != nil }
        #expect(editor.string == "合成失败重试稿")
        _ = AXUIElementPerformAction(try await fixture.sendButton(enabled: true), kAXPressAction as CFString)
        try await page.waitForSend(count: 2)
        try await page.completeSend()
        try await fixture.wait { editor.string.isEmpty }
        #expect(try await page.webView.evaluateJavaScript("window.sent") as? [String] == ["合成失败重试稿", "合成失败重试稿"])
    }

    /// Read-only synthetic projections never connect this composer to a model service or user data root.
    @MainActor private final class Fixture {
        /// The real action boundary rejects because this initial fixture has no coordinator.
        let state = NativeApplicationState()
        /// The only text editor and accessibility actions belong to this disposable window.
        let window: NSWindow
        /// An optional local reply page acknowledges commands without executing a model or storage service.
        let page: ReplyPage?

        /// A ready synthetic AI projection enables normal controls without granting service authority.
        init(bridge: Bool = false) throws {
            page = bridge ? try ReplyPage(application: state) : nil
            let session = page?.coordinator.sessionId ?? "ai-draft"
            state.beginSession(session)
            try state.receiveProjection([
                "protocolVersion": 1, "sessionId": session, "sequence": 1,
                "projection": [
                    "app": ["route": "editor", "project": ["id": "fixture", "name": "合成剧本"]],
                    "ai": ["projectId": "fixture", "ready": true, "busy": false, "thread": []]
                ]
            ])
            window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 620),
                              styleMask: [.titled], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.level = .floating
            mount()
            window.orderFrontRegardless()
        }

        /// Mounts the actual composer under the same fixed pane constraints used by this disposable window.
        func mount() {
            window.contentView = NSHostingView(rootView: NativeAiView(state: state, projectId: "fixture").frame(width: 600, height: 620))
            window.contentView?.layoutSubtreeIfNeeded()
        }

        /// NSTextView's public change delivery updates the actual SwiftUI TextEditor binding.
        func enter(_ text: String, in editor: NSTextView) {
            editor.string = text
            editor.didChangeText()
        }

        /// Finds the active native composer after its SwiftUI control has mounted.
        func editor() async throws -> NSTextView {
            var result: NSTextView?
            try await wait {
                result = self.descendants(self.window.contentView).compactMap { $0 as? NSTextView }.first { $0.isEditable }
                return result != nil
            }
            return try #require(result)
        }

        /// Accessibility readiness follows the real mounted composer rather than its initial hosting-view skeleton.
        func sendButton(enabled: Bool? = nil) async throws -> AXUIElement {
            let deadline = ContinuousClock.now.advanced(by: .seconds(5))
            repeat {
                let elements = try await NativeCreationControlFixture.elements(in: window)
                if let button = elements.first(where: {
                    NativeCreationControlFixture.string($0, kAXRoleAttribute) == kAXButtonRole
                        && NativeCreationControlFixture.string($0, kAXDescriptionAttribute) == "发送"
                }) {
                    if let enabled, try NativeCreationControlFixture.isEnabled(button) != enabled { continue }
                    return button
                }
            } while ContinuousClock.now < deadline
            throw HostFailure(code: "PW_TEST_COMPOSER_TIMEOUT", message: "合成窗口的发送控件未就绪")
        }

        /// Bounded waits observe state and controls rather than assuming an asynchronous callback has run.
        func wait(_ predicate: () -> Bool) async throws {
            let deadline = ContinuousClock.now.advanced(by: .seconds(5))
            while !predicate() && ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
            try #require(predicate())
        }

        /// Traversal is restricted to the fixture's own public AppKit tree.
        private func descendants(_ view: NSView?) -> [NSView] {
            guard let view else { return [] }
            return [view] + view.subviews.flatMap { descendants($0) }
        }

        /// Removes the disposable window without invoking application quit or service writes.
        func remove() { window.close(); window.contentView = nil; page?.remove() }
    }

    /// A real WK promise provides deterministic admission replies and never calls a public endpoint or persistent service.
    @MainActor private final class ReplyPage {
        /// Owned local WebKit page records only synthetic prompts from this test.
        let webView: WKWebView
        /// Session authority and native intent futures use the production coordinator.
        let coordinator: WebCanvasCoordinator
        /// Ready state belongs solely to this fixture document.
        private let canvas = WebCanvasState()
        /// The HTML fixture is removed with its handler registrations.
        private let root: URL

        /// Installs a local page that delays only AI sends and replies immediately to unrelated barrier commands.
        init(application: NativeApplicationState) throws {
            root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-ai-draft-" + UUID().uuidString)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            let entry = root.appendingPathComponent("reply.html")
            try Data("""
                <!doctype html><script>
                window.sent = [];
                window.__pwNativeIntent = async request => {
                  if (request.command !== 'ai.send') return {ok: null};
                  window.sent.push(request.args.text);
                  return await new Promise(resolve => window.finishSend = resolve);
                };
                window.webkit.messageHandlers.canvasHost.postMessage({
                    event: 'ready', protocolVersion: 1, sessionId: window.__pwNativeHost.sessionId
                });
                </script>
                """.utf8).write(to: entry)
            let configuration = WKWebViewConfiguration()
            webView = try IsolatedWebViewFixture.makeWebView(frame: NSRect(x: 0, y: 0, width: 400, height: 300), configuration: configuration)
            coordinator = WebCanvasCoordinator(state: canvas, appearance: CanvasAppearanceState(), entryURL: entry,
                                               services: NativeHostServices(dataRoot: nil, quit: HostQuitController()))
            configuration.userContentController.add(coordinator, name: WebCanvasCoordinator.bridgeName)
            webView.navigationDelegate = coordinator
            coordinator.loadCanvas(into: webView)
            application.connect(coordinator)
        }

        /// The actual ready message establishes bridge availability before any simulated user send.
        func waitUntilReady() async throws {
            let deadline = ContinuousClock.now.advanced(by: .seconds(5))
            while canvas.phase == .loading && ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
            try #require(canvas.phase == .ready)
        }

        /// Observes the real received request count, so draft assertions precede acknowledgment with certainty.
        func waitForSend(count: Int) async throws {
            let deadline = ContinuousClock.now.advanced(by: .seconds(5))
            while ContinuousClock.now < deadline {
                if try await webView.evaluateJavaScript("window.sent.length") as? Int == count { return }
                try await Task.sleep(for: .milliseconds(20))
            }
            throw HostFailure(code: "PW_TEST_AI_SEND_TIMEOUT", message: "隔离 AI 页面未收到发送意图")
        }

        /// Releases exactly the currently received request with a structured success or admission failure.
        func completeSend(errorCode: String? = nil) async throws {
            let reply: HostJSON = errorCode.map { .object(["error": .object(["code": .string($0), "message": .string("合成 admission 拒绝")])]) }
                ?? .object(["ok": .null])
            _ = try await webView.callAsyncJavaScript("window.finishSend(reply); return null;", arguments: ["reply": reply.webValue], in: nil, contentWorld: .page)
        }

        /// Invalidation cancels owned work before unregistering handlers and deleting the local page.
        func remove() {
            webView.stopLoading()
            coordinator.invalidateSession()
            webView.configuration.userContentController.removeScriptMessageHandler(forName: "plotweaveHost")
            webView.configuration.userContentController.removeScriptMessageHandler(forName: WebCanvasCoordinator.bridgeName)
            try? FileManager.default.removeItem(at: root)
        }
    }
}
