import AppKit
import SwiftUI
import Testing
import WebKit
@testable import PlotWeaveNative

/// Production home navigation retains the native canvas host and saved document.
/// This replaces the earlier memory-only demo regression (integration matrix I2).
@MainActor
@Suite(.serialized, WebKitTestIsolation())
struct ShellHomeNavigationTests {
    /// Native dimensions and Web viewport transform are separate observable initialization concerns.
    private struct CanvasFrame: Equatable {
        /// The rendered React Flow region follows the native column geometry.
        let size: CGSize
        /// A missing saved viewport may require one initial fit after nodes are measured.
        let transform: String
        /// Native visibility and bounds distinguish an actual visible relayout from an old hidden Web frame.
        let nativeSize: CGSize
        /// Navigation may publish the editor route before SwiftUI reveals the retained canvas.
        let hidden: Bool
    }

    /// Saved restoration and first fit must not expose repeated native canvas relayouts (N85–N86).
    @Test(arguments: [true, false], [NSSize(width: 1100, height: 750), NSSize(width: 960, height: 600)])
    func openingProjectPresentsStableCanvasGeometry(savedViewport: Bool, contentSize: NSSize) async throws {
        let fixture = Fixture(contentSize: contentSize)
        defer { fixture.remove() }
        let id = try await fixture.createProject()
        let webView = try await fixture.waitForReady()
        _ = try await fixture.state.request("app.open", args: ["id": .string(id)])
        try await wait { fixture.state.route == "editor" }
        for type in ["scene", "branch", "dialogue"] {
            _ = try await fixture.state.request("editor.create", args: ["projectId": .string(id), "nodeType": .string(type)])
        }
        _ = try await fixture.state.request("editor.fit", args: ["projectId": .string(id)])
        _ = try await fixture.state.request("app.home")
        try await wait { fixture.presentation.welcomeWindow != nil }
        if !savedViewport { try await removeSavedViewport(fixture: fixture, id: id) }
        _ = try await fixture.state.request("app.open", args: ["id": .string(id)])
        var frames: [CanvasFrame] = []
        for _ in 0..<40 {
            if fixture.window.alphaValue > 0, fixture.state.route == "editor", !webView.isHidden {
                if let frame = try await canvasFrame(webView) { frames.append(frame) }
            }
            try await Task.sleep(for: .milliseconds(30))
        }
        #expect(!frames.isEmpty)
        #expect(frames.allSatisfy { $0.size == frames.first?.size }, "可见画布尺寸应一次落定：\(frames)")
        let changes = zip(frames, frames.dropFirst()).filter { $0.transform != $1.transform }.count
        #expect(changes <= (savedViewport ? 0 : 1), "保存视口不跳变；无保存视口只允许一次首开适配：\(frames)")
        #expect(findWebView(fixture.window.contentView) === webView)
        #expect(fixture.state.editor["canUndo"] == .bool(false))
        await fixture.services.close()
    }

    /// Only an already-flushed isolated document is changed to exercise the missing-viewport boundary.
    private func removeSavedViewport(fixture: Fixture, id: String) async throws {
        let store = try #require(fixture.services.projectStore)
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        var document = try await store.invoke(command: "load_project", args: ["id": .string(id)])
        while document["graph"]?["nodes"]?.arrayValue?.count != 3, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(30))
            document = try await store.invoke(command: "load_project", args: ["id": .string(id)])
        }
        #expect(document["graph"]?["nodes"]?.arrayValue?.count == 3)
        var fields = try #require(document.object)
        var graph = try #require(fields["graph"]?.object)
        graph.removeValue(forKey: "viewport")
        fields["graph"] = .object(graph)
        _ = try await store.invoke(command: "save_project", args: ["id": .string(id), "doc": .object(fields)])
    }

    /// Measures each visible browser repaint; arbitrary script turns may still see the hidden page's old viewport.
    private func canvasFrame(_ webView: WKWebView) async throws -> CanvasFrame? {
        guard let values = try await webView.callAsyncJavaScript("""
            return await new Promise((resolve, reject) => {
                const frame = requestAnimationFrame(() => {
                    clearTimeout(deadline);
                    const flow = document.querySelector('.react-flow');
                    const viewport = document.querySelector('.react-flow__viewport');
                    if (!flow || !viewport || document.querySelectorAll('.react-flow__node').length !== 3) {
                        resolve(null);
                        return;
                    }
                    const rect = flow.getBoundingClientRect();
                    resolve([rect.width, rect.height, viewport.style.transform]);
                });
                const deadline = setTimeout(() => {
                    cancelAnimationFrame(frame);
                    reject(new Error('PW_CANVAS_FRAME_TIMEOUT'));
                }, 1000);
            });
            """, arguments: [:], in: nil, contentWorld: .page) as? [Any] else { return nil }
        #expect(values.count == 3)
        let width = try #require(values.first as? Double)
        let height = try #require(values.dropFirst().first as? Double)
        let transform = try #require(values.last as? String)
        return CanvasFrame(size: CGSize(width: width, height: height), transform: transform,
                           nativeSize: webView.bounds.size, hidden: webView.isHidden)
    }

    /// Each explicit welcome-page entry opens the selected persisted ID through the retained editing session.
    @Test(arguments: ["button", "return"])
    func selectedWelcomeProjectOpensWithoutCreatingAnother(entry: String) async throws {
        let fixture = Fixture()
        defer { fixture.remove() }
        _ = try await fixture.createProject()
        _ = try await fixture.createProject()
        let webView = try await fixture.waitForReady()
        _ = try await fixture.state.request("app.retry")
        try await wait { NativeHomeProjection(fixture.state.app).projects.count == 2 }
        try await Task.sleep(for: .milliseconds(300))
        let rows = NativeHomeProjection(fixture.state.app).projects
        let selected = try #require(rows.last?.id)
        let table = try #require(findTableView(fixture.interactionWindow.contentView))
        fixture.interactionWindow.makeKeyAndOrderFront(nil)
        #expect(fixture.interactionWindow.makeFirstResponder(table))
        table.selectRowIndexes(IndexSet(integer: 1), byExtendingSelection: false)
        try await Task.sleep(for: .milliseconds(100))
        #expect(fixture.state.route == "home" && !fixture.state.busy)
        try await activate(entry, window: fixture.interactionWindow)
        try await wait { fixture.state.route == "editor" && !fixture.state.busy }
        #expect(fixture.state.projectId == selected)
        #expect(findWebView(fixture.window.contentView) === webView)
        let store = try #require(fixture.services.projectStore)
        let after = try await store.invoke(command: "list_projects", args: [:])
        #expect(Set(after.arrayValue?.compactMap { $0["id"]?.string } ?? []) == Set(rows.map(\.id)))
        #expect(try await store.invoke(command: "load_project", args: ["id": .string(selected)])["graph"] != nil)
        await fixture.services.close()
    }

    /// Repairing an unreadable document lets the real native recovery button reopen its original ID.
    @Test func failedOpeningRetriesOriginalProjectAfterRepair() async throws {
        let fixture = Fixture()
        defer { fixture.remove() }
        let id = try await fixture.createProject()
        let webView = try await fixture.waitForReady()
        _ = try await fixture.state.request("app.retry")
        try await wait { NativeHomeProjection(fixture.state.app).contains(id: id) }
        try await Task.sleep(for: .milliseconds(300))
        let table = try #require(findTableView(fixture.interactionWindow.contentView))
        let index = try #require(NativeHomeProjection(fixture.state.app).projects.firstIndex { $0.id == id })
        table.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false)
        let open = try await NativeCreationControlFixture.button(in: fixture.interactionWindow, named: "打开项目")
        let store = try #require(fixture.services.projectStore)
        let file = fixture.root.appendingPathComponent("projects/\(id).json")
        let original = try Data(contentsOf: file)
        try Data("invalid fixture document".utf8).write(to: file)
        try NativeCreationControlFixture.press(open)
        try await wait { !fixture.state.busy && (fixture.state.error != nil || NativeHomeProjection(fixture.state.app).error != nil) }
        #expect(fixture.state.route == "home")
        #expect(findWebView(fixture.window.contentView) === webView)
        try original.write(to: file)
        let retry = try await NativeCreationControlFixture.button(in: fixture.interactionWindow, named: "重试打开")
        try NativeCreationControlFixture.press(retry)
        try await wait { fixture.state.route == "editor" && !fixture.state.busy }
        #expect(fixture.state.projectId == id && fixture.state.error == nil)
        #expect(NativeHomeProjection(fixture.state.app).error == nil)
        #expect(try await store.invoke(command: "load_project", args: ["id": .string(id)])["project"]?["name"]?.string == "首页集成回归")
        await fixture.services.close()
    }

    /// The existing Web failure closure retains a submitted rename after its sheet is gone and retries into real Swift storage.
    @Test func failedRenameRetriesOriginalDraftIntoNativeStorage() async throws {
        let fixture = Fixture()
        defer { fixture.remove() }
        let id = try await fixture.createProject()
        _ = try await fixture.waitForReady()
        let file = fixture.root.appendingPathComponent("projects/\(id).json")
        let original = try Data(contentsOf: file)
        try Data("invalid fixture document".utf8).write(to: file)
        _ = try await fixture.state.request("app.rename", args: ["id": .string(id), "name": .string("保留的重命名原稿")])
        try await wait { !fixture.state.busy && NativeHomeProjection(fixture.state.app).error != nil }
        try original.write(to: file)
        let retry = try await NativeCreationControlFixture.button(in: fixture.interactionWindow, named: "重试重命名")
        try NativeCreationControlFixture.press(retry)
        try await wait { !fixture.state.busy && NativeHomeProjection(fixture.state.app).error == nil }
        let store = try #require(fixture.services.projectStore)
        #expect(try await store.invoke(command: "load_project", args: ["id": .string(id)])["project"]?["name"]?.string == "保留的重命名原稿")
        #expect(NativeHomeProjection(fixture.state.app).projects.first { $0.id == id }?.name == "保留的重命名原稿")
        #expect(fixture.state.route == "home")
        await fixture.services.close()
    }

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
        let button = try await NativeCreationControlFixture.button(in: fixture.interactionWindow)
        let open = try await NativeCreationControlFixture.button(in: fixture.interactionWindow, named: "打开项目")
        try NativeCreationControlFixture.press(button)
        try await Task.sleep(for: .milliseconds(300))
        #expect(fixture.state.busy)
        #expect(try !NativeCreationControlFixture.isEnabled(button))
        #expect(try !NativeCreationControlFixture.isEnabled(open))
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
    @Test(arguments: ["app.home", "app.settings", "window.close"])
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
        let editorFrame = fixture.window.frame

        for _ in 0..<2 {
            #expect(fixture.window.makeFirstResponder(webView))
            if command == "window.close" {
                try #require(fixture.window.standardWindowButton(.closeButton)).performClick(nil)
            }
            else { _ = try await fixture.state.request(command) }
            try await wait { fixture.state.route == (command == "app.settings" ? "settings" : "home") }
            try await Task.sleep(for: .milliseconds(300))
            if command != "app.settings" {
                #expect(fixture.presentation.welcomeWindow?.frame.size == NativeWelcomeMetrics.windowSize)
                #expect(fixture.window.alphaValue == 0 && fixture.window.ignoresMouseEvents)
                // AppKit may reflow hidden toolbar height; the retained editor is never reduced to the card viewport.
                #expect(fixture.window.frame.width == editorFrame.width && fixture.window.frame.height >= 600)
            }
            #expect(webView.isHidden, "原生页面必须隐藏 WebKit 编辑表面")
            if let responder = fixture.window.firstResponder as? NSView {
                #expect(!responder.isDescendant(of: webView), "原生页面不能保留隐藏画布的编辑焦点")
            }
            _ = try await fixture.state.request("app.open", args: ["id": .string(id)])
            try await wait { fixture.state.route == "editor" }
            try await Task.sleep(for: .milliseconds(300))
            #expect(fixture.presentation.welcomeWindow == nil && fixture.window.isVisible)
            #expect(fixture.window.frame == editorFrame)
            #expect(fixture.window.styleMask.contains(.resizable))
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

    /// Repeated red-button clicks share one pending navigation; a failed reply keeps editing and permits retry (N78).
    @Test func projectCloseWaitsForNavigationAndCanRetryFailure() async throws {
        let fixture = Fixture()
        defer { fixture.remove() }
        let id = try await fixture.createProject()
        let webView = try await fixture.waitForReady()
        _ = try await fixture.state.request("app.open", args: ["id": .string(id)])
        try await wait { fixture.state.route == "editor" }
        try await Task.sleep(for: .milliseconds(200))
        try await webView.evaluateJavaScript("""
            const original = window.__pwNativeIntent;
            window.__pwHomeCalls = 0;
            window.__pwNativeIntent = request => request.command !== 'app.home'
                ? original(request)
                : new Promise(resolve => {
                    window.__pwHomeCalls += 1;
                    window.__pwRejectHome = () => {
                        window.__pwNativeIntent = original;
                        resolve({ error: { code: 'PW_NAVIGATION_FAILED', message: '隔离导航失败' } });
                    };
                });
            undefined;
            """)
        let close = try #require(fixture.window.standardWindowButton(.closeButton))
        close.performClick(nil)
        #expect(fixture.state.busy)
        close.performClick(nil)
        close.performClick(nil)
        try await Task.sleep(for: .milliseconds(200))
        #expect(try await webView.evaluateJavaScript("window.__pwHomeCalls") as? Int == 1)
        #expect(fixture.state.route == "editor" && fixture.window.isVisible && fixture.presentation.welcomeWindow == nil)
        try await webView.evaluateJavaScript("window.__pwRejectHome(); undefined")
        try await wait { !fixture.state.busy && fixture.state.error != nil }
        #expect(fixture.state.route == "editor" && fixture.state.projectId == id)
        #expect(fixture.state.error?.contains("隔离导航失败") == true)
        close.performClick(nil)
        try await wait { fixture.state.route == "home" && !fixture.state.busy }
        try await Task.sleep(for: .milliseconds(200))
        #expect(fixture.state.error == nil && fixture.presentation.welcomeWindow != nil)
        #expect(findWebView(fixture.window.contentView) === webView)
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

    /// Uses the actual button's AX press action or a public AppKit keyboard event.
    private func activate(_ entry: String, window: NSWindow) async throws {
        if entry == "button" {
            let button = try await NativeCreationControlFixture.button(in: window, named: "打开项目")
            try NativeCreationControlFixture.press(button)
        } else {
            let event = try #require(NSEvent.keyEvent(
                with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0,
                windowNumber: window.windowNumber, context: nil, characters: "\r",
                charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36
            ))
            window.sendEvent(event)
        }
    }

    /// Locates a native list by supported table semantics without depending on private SwiftUI class names.
    private func findTableView(_ view: NSView?) -> NSTableView? {
        guard let view else { return nil }
        if let table = view as? NSTableView { return table }
        for child in view.subviews { if let table = findTableView(child) { return table } }
        return nil
    }

    /// Services and windows are isolated from every real application data directory.
    @MainActor private final class Fixture {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-home-integration-" + UUID().uuidString)
        let state = NativeApplicationState()
        let presentation = NativeWelcomeWindowController()
        let layout = ShellLayoutState()
        let services: NativeHostServices
        let window: NSWindow

        /// AX and mouse actions target the visible card at home and the retained editor elsewhere.
        var interactionWindow: NSWindow { presentation.welcomeWindow ?? window }

        /// Mounts production code with a disposable native service root.
        init(inspectorVisible: Bool = true, contentSize: NSSize = NSSize(width: 1100, height: 750)) {
            services = NativeHostServices(dataRoot: root, quit: HostQuitController())
            layout.inspectorVisible = inspectorVisible
            // Match the real unified SwiftUI window's full-size content and safe-area behavior.
            window = NSWindow(contentRect: NSRect(origin: .zero, size: contentSize),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.toolbarStyle = .unified
            window.level = .floating
            window.contentView = NSHostingView(rootView: NativeShellRoot(
                layout: layout, services: services, application: state, windowPresentation: presentation
            ))
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
