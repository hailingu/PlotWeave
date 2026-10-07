import AppKit
import SwiftUI
import Testing
import WebKit
@testable import PlotWeaveNative

/// Production home navigation retains the native canvas host and saved document.
/// This replaces the earlier memory-only demo regression (integration matrix I2).
@MainActor
@Suite(.serialized)
struct ShellHomeNavigationTests {
    /// The real homepage button must remain unavailable during creation and commit only one new native project.
    @Test func creationButtonCommitsOnceAndOpensEditor() async throws {
        let fixture = Fixture()
        defer { fixture.remove() }
        let webView = try await fixture.waitForReady()
        let projects = try #require(fixture.services.projectStore)
        let before = try await projects.invoke(command: "list_projects", args: [:])
        let originalIDs = Set(before.arrayValue?.compactMap { $0["id"]?.string } ?? [])
        try await webView.evaluateJavaScript("""
            const original = window.__pwNativeIntent;
            window.__pwNativeIntent = request => request.command !== 'app.create'
                ? original(request)
                : new Promise(resolve => {
                    window.__pwReleaseCreate = () => original(request).then(resolve);
                });
            undefined;
            """)
        let button = try await NativeCreationControlFixture.button(in: fixture.window)
        try NativeCreationControlFixture.press(button)
        try await Task.sleep(for: .milliseconds(300))
        #expect(fixture.state.busy)
        #expect(try !NativeCreationControlFixture.isEnabled(button))
        try await webView.evaluateJavaScript("window.__pwReleaseCreate(); undefined")
        try await wait { fixture.state.route == "editor" && !fixture.state.busy }
        let id = try #require(fixture.state.projectId)
        let after = try await projects.invoke(command: "list_projects", args: [:])
        let currentIDs = Set(after.arrayValue?.compactMap { $0["id"]?.string } ?? [])
        #expect(currentIDs.subtracting(originalIDs) == Set([id]))
        #expect(try await projects.invoke(command: "load_project", args: ["id": .string(id)])["graph"] != nil)
        #expect(findWebView(fixture.window.contentView) === webView)
        await fixture.services.close()
    }

    /// Home and settings release WebKit editing focus; reopening uses the same page.
    @Test(arguments: ["app.home", "app.settings"])
    func nativeNavigationReturnsToSameCanvasAndSavedDocument(command: String) async throws {
        let fixture = Fixture()
        defer { fixture.remove() }
        let id = try await fixture.createProject()
        let webView = try await fixture.waitForReady()
        _ = try await fixture.state.request("app.open", args: ["id": .string(id)])
        try await wait { fixture.state.route == "editor" }
        _ = try await fixture.state.request("editor.create", args: [
            "projectId": .string(id), "nodeType": .string("scene")
        ])
        try await wait { fixture.state.editor["nodes"]?.arrayValue?.count == 1 }
        let node = try #require(fixture.state.editor["nodes"]?.arrayValue?.first?["id"]?.string)
        _ = try await fixture.state.request("editor.patchNode", args: [
            "projectId": .string(id), "id": .string(node),
            "patch": .object(["synopsis": .string("首页往返后保留的稿件")])
        ])
        try await webView.evaluateJavaScript("window.__pwHomeProbe = 271828")
        let identity = ObjectIdentifier(webView)

        for _ in 0..<2 {
            #expect(fixture.window.makeFirstResponder(webView))
            if command == "app.home" { try ProjectLibraryToolbarFixture.activateReturn(in: fixture.window) }
            else { _ = try await fixture.state.request(command) }
            try await wait { fixture.state.route == (command == "app.home" ? "home" : "settings") }
            try await Task.sleep(for: .milliseconds(300))
            #expect(webView.isHidden, "原生页面必须隐藏 WebKit 编辑表面")
            if let responder = fixture.window.firstResponder as? NSView {
                #expect(!responder.isDescendant(of: webView), "原生页面不能保留隐藏画布的编辑焦点")
            }
            _ = try await fixture.state.request("app.open", args: ["id": .string(id)])
            try await wait { fixture.state.route == "editor" }
            try await Task.sleep(for: .milliseconds(300))
            #expect(!webView.isHidden)
            #expect(ObjectIdentifier(try #require(findWebView(fixture.window.contentView))) == identity)
            #expect(try await webView.evaluateJavaScript("window.__pwHomeProbe") as? Int == 271828)
            let exported = try await fixture.state.request("editor.exportPreview", args: [
                "projectId": .string(id), "format": .string("json")
            ])
            let document = try JSONDecoder().decode(HostJSON.self, from: Data(try #require(exported["text"]?.string).utf8))
            #expect(document["graph"]?["nodes"]?.arrayValue?.first?["data"]?["spec"]?["synopsis"]?.string == "首页往返后保留的稿件")
        }
        await fixture.services.close()
    }

    /// Initial home hides the canvas after loading without replacing the user's panel preference.
    @Test(arguments: [true, false])
    func initialHomePreservesCanvasAndPanelPreference(inspectorVisible: Bool) async throws {
        let fixture = Fixture(inspectorVisible: inspectorVisible)
        defer { fixture.remove() }
        let webView = try await fixture.waitForReady()
        try await Task.sleep(for: .milliseconds(300))
        #expect(webView.isHidden)
        #expect(fixture.layout.inspectorVisible == inspectorVisible)
        let id = try await fixture.createProject()
        _ = try await fixture.state.request("app.open", args: ["id": .string(id)])
        try await wait { fixture.state.route == "editor" }
        try await Task.sleep(for: .milliseconds(300))
        #expect(!webView.isHidden)
        #expect(fixture.layout.inspectorVisible == inspectorVisible)
        #expect(findWebView(fixture.window.contentView) === webView)
        await fixture.services.close()
    }

    /// Bounded waits assert actual projection state rather than source layout.
    private func wait(_ predicate: () -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(12))
        while !predicate() && ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(30)) }
        try #require(predicate(), "原生首页状态转换超时")
    }

    /// Finds the retained host under the real SwiftUI view composition.
    private func findWebView(_ view: NSView?) -> WKWebView? {
        guard let view else { return nil }
        if let webView = view as? WKWebView { return webView }
        for child in view.subviews { if let found = findWebView(child) { return found } }
        return nil
    }

    /// Services and windows are isolated from every real application data directory.
    @MainActor private final class Fixture {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-home-integration-" + UUID().uuidString)
        let state = NativeApplicationState()
        let layout = ShellLayoutState()
        let services: NativeHostServices
        let window: NSWindow

        /// Mounts production code with a disposable native service root.
        init(inspectorVisible: Bool = true) {
            services = NativeHostServices(dataRoot: root, quit: HostQuitController())
            layout.inspectorVisible = inspectorVisible
            window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 750), styleMask: [.titled], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.level = .floating
            window.contentView = NSHostingView(rootView: NativeShellRoot(layout: layout, services: services, application: state))
            window.contentView?.layoutSubtreeIfNeeded()
            window.orderFrontRegardless()
        }

        /// Creates a real native project while preserving its immutable identity.
        func createProject() async throws -> String {
            let store = try #require(services.projectStore)
            let value = try await store.invoke(command: "create_project", args: ["name": .string("首页集成回归")])
            return try #require(value["id"]?.string)
        }

        /// Waits for both the projection and the page's native-intent ready guard.
        func waitForReady() async throws -> WKWebView {
            let deadline = ContinuousClock.now.advanced(by: .seconds(15))
            while ContinuousClock.now < deadline {
                if state.route == "home", state.app["loading"] == .bool(false),
                   let webView = firstWebView(window.contentView),
                   let coordinator = webView.navigationDelegate as? WebCanvasCoordinator {
                    do {
                        // nativeShell.ts rejects version 0 before dispatch; this is its readiness contract.
                        let response = try await coordinator.sendNativeIntent(request: [
                            "protocolVersion": 0, "sessionId": coordinator.sessionId,
                            "requestId": "home-ready", "command": "readiness.probe", "args": [:]
                        ])
                        let reply = try HostJSON(webValue: response)
                        if reply["error"]?["code"]?.string == "PW_INVALID_NATIVE_INTENT" { return webView }
                    } catch let error as HostFailure where error.code == "PW_CANVAS_NOT_READY" { }
                }
                try await Task.sleep(for: .milliseconds(40))
            }
            throw HostFailure(code: "PW_CANVAS_NOT_READY", message: "首页生产页未完成握手")
        }

        /// Looks up the mounted host without acquiring or replacing a second page.
        private func firstWebView(_ view: NSView?) -> WKWebView? {
            guard let view else { return nil }
            if let webView = view as? WKWebView { return webView }
            for child in view.subviews { if let found = firstWebView(child) { return found } }
            return nil
        }

        /// Invalidates the disposable page before removing only this fixture's files.
        func remove() {
            window.close()
            window.contentView = nil
            try? FileManager.default.removeItem(at: root)
        }
    }
}
