import AppKit
import ApplicationServices
import SwiftUI
import Testing
import WebKit
@testable import PlotWeaveNative

/// Actual native settings controls and a production Web owner preserve edits across delayed projections.
@MainActor
@Suite(.serialized)
struct NativeSettingsEditingTests {
    /// Two native choices compose while both controls still display the original read projection.
    @Test(arguments: [true, false])
    func consecutiveDefaultSelectionsPersistBothFields(chatFirst: Bool) async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        try await fixture.start()
        let pickers = try await fixture.pickers()
        fixture.pauseProjections = true
        let choices = chatFirst ? [(0, "fixture:new-chat"), (1, "fixture:new-image")]
            : [(1, "fixture:new-image"), (0, "fixture:new-chat")]
        for (index, value) in choices {
            try await fixture.choose(value, in: pickers[index], field: index == 0 ? "defaultChat" : "defaultImage")
            try await fixture.drain()
        }
        try fixture.resumeProjections()
        _ = try await fixture.state.request("settings.close")
        let saved = try fixture.readSettings()
        #expect(saved["defaultChat"]?.string == "fixture:new-chat")
        #expect(saved["defaultImage"]?.string == "fixture:new-image")
        await fixture.services.close()
    }

    /// An earlier echo cannot overwrite newer typed text or make the following edit persist a truncated draft.
    @Test func earlierProviderEchoPreservesNewerNameAndAddress() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        try await fixture.start()
        let name = try await fixture.field(value: "初始服务")
        let address = try await fixture.field(value: "https://fixture.example/v1")
        fixture.pauseProjections = true
        fixture.enter("名称甲", in: name)
        fixture.enter("https://first.example/v1", in: address)
        try await fixture.wait { fixture.bufferedProjection != nil }
        try await fixture.drain()
        let earlier = try #require(fixture.bufferedProjection)
        fixture.enter("名称甲乙", in: name)
        fixture.enter("https://second.example/v1", in: address)
        try await fixture.wait { fixture.bufferedProjection?["sequence"] as? NSNumber != earlier["sequence"] as? NSNumber }
        try await fixture.drain()
        try fixture.state.receiveProjection(earlier)
        try await fixture.wait { fixture.state.settings["providers"]?.array.last?["label"]?.string == "名称甲" }
        try await Task.sleep(for: .milliseconds(100))
        #expect(name.stringValue == "名称甲乙")
        #expect(address.stringValue == "https://second.example/v1")
        fixture.enter(name.stringValue + "丙", in: name)
        fixture.enter(address.stringValue + "/next", in: address)
        try await fixture.drain()
        try fixture.resumeProjections()
        _ = try await fixture.state.request("settings.close")
        let provider = try #require(fixture.readSettings()["providers"]?.array.last)
        #expect(provider["label"]?.string == "名称甲乙丙")
        #expect(provider["baseUrl"]?.string == "https://second.example/v1/next")
        await fixture.services.close()
    }

    /// A reverted value equals the prior authority again, so only edit identities keep the stale echo from consuming the newer draft.
    @Test func revertedProviderEditKeepsNewerDraftAheadOfStaleEcho() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        try await fixture.start()
        let name = try await fixture.field(value: "初始服务")
        let address = try await fixture.field(value: "https://fixture.example/v1")
        fixture.pauseProjections = true
        fixture.enter("名称甲", in: name)
        fixture.enter("https://revert.example/v1", in: address)
        try await fixture.wait { fixture.bufferedProjection != nil }
        try await fixture.drain()
        let earlier = try #require(fixture.bufferedProjection)
        fixture.enter("初始服务", in: name)
        fixture.enter("https://fixture.example/v1", in: address)
        try await fixture.wait { fixture.bufferedProjection?["sequence"] as? NSNumber != earlier["sequence"] as? NSNumber }
        try await fixture.drain()
        try fixture.state.receiveProjection(earlier)
        try await fixture.wait { fixture.state.settings["providers"]?.array.last?["label"]?.string == "名称甲" }
        try await Task.sleep(for: .milliseconds(100))
        #expect(name.stringValue == "初始服务")
        #expect(address.stringValue == "https://fixture.example/v1")
        fixture.enter(name.stringValue + "丙", in: name)
        fixture.enter(address.stringValue + "/next", in: address)
        try await fixture.drain()
        try fixture.resumeProjections()
        _ = try await fixture.state.request("settings.close")
        let provider = try #require(fixture.readSettings()["providers"]?.array.last)
        #expect(provider["label"]?.string == "初始服务丙")
        #expect(provider["baseUrl"]?.string == "https://fixture.example/v1/next")
        await fixture.services.close()
    }

    /// Only this fixture's roots, windows, production Web page and settings saver can receive the synthetic edits.
    @MainActor private final class Fixture {
        /// Settings never reach an application-support or Tauri root.
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-settings-edit-" + UUID().uuidString)
        /// The actual read consumer and native intent futures own every control action.
        let state = NativeApplicationState()
        /// Native services persist only the isolated settings file.
        let services: NativeHostServices
        /// A dedicated settings window avoids mounting unrelated split-view geometry.
        let window: NSWindow
        /// The visible browser owns the same production React settings controller used by the application.
        let webWindow: NSWindow
        /// Its frame-driven handshake remains independent of the settings control window.
        let webView: WKWebView
        /// Read delivery can lag independently of native intent completion without replacing the Web owner.
        var pauseProjections = false
        /// The latest real envelope is retained only to release the test's delivery gate.
        private(set) var bufferedProjection: [String: Any]?
        /// Canvas readiness is observed through the production ready handshake.
        private let canvas = WebCanvasState()
        /// Coordinator ownership is released before disposable data teardown.
        private var coordinator: WebCanvasCoordinator?

        /// Seeds credential-free values, then connects a standalone production page to the real form.
        init() throws {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            try Data("""
                {"providers":[{"id":"fixture","label":"初始服务","baseUrl":"https://fixture.example/v1",
                "enabled":true,"models":["old-chat","new-chat","old-image","new-image"]}],
                "defaultChat":"fixture:old-chat","defaultImage":"fixture:old-image"}
                """.utf8).write(to: root.appendingPathComponent("settings.json"))
            services = NativeHostServices(dataRoot: root, quit: HostQuitController())
            window = Self.makeWindow(size: NSSize(width: 800, height: 1500))
            webWindow = Self.makeWindow(size: NSSize(width: 900, height: 600))
            let configuration = WKWebViewConfiguration()
            webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 900, height: 600), configuration: configuration)
            let content = NSHostingView(rootView: NativeSettingsView(state: state))
            content.sizingOptions = []
            window.contentView = content
            webWindow.contentView = webView
            let owner = WebCanvasCoordinator(state: canvas, appearance: CanvasAppearanceState(), services: services,
                onProjection: { [weak self] in self?.receive($0) }, onConnection: { [weak state] in state?.connect($0) })
            coordinator = owner
            configuration.userContentController.add(owner, name: WebCanvasCoordinator.bridgeName)
            webView.navigationDelegate = owner
            owner.loadCanvas(into: webView)
            webWindow.orderFrontRegardless()
            window.orderFrontRegardless()
        }

        /// Public windows have fixed fixture geometry and are disposed without invoking the application quit delegate.
        private static func makeWindow(size: NSSize) -> NSWindow {
            let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.titled], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.level = .floating
            return window
        }

        /// Read delivery uses the real ordered projection validator; invalid fixture envelopes fail the test.
        private func receive(_ envelope: [String: Any]) {
            if pauseProjections { bufferedProjection = envelope; return }
            do { try state.receiveProjection(envelope) }
            catch { Issue.record("生产设置投影被拒绝：\(error)") }
        }

        /// Explicit settings navigation waits for the actual production load rather than synthetic ready fields.
        func start() async throws {
            try await wait { self.canvas.phase == .ready && self.state.route == "home" && self.state.app["loading"] == .bool(false) }
            _ = try await state.request("app.settings")
            try await wait { self.state.settings["phase"]?.string == "ready" }
        }

        /// Unblocks only the latest queued read envelope, preserving the production sequence contract.
        func resumeProjections() throws {
            pauseProjections = false
            if let bufferedProjection { try state.receiveProjection(bufferedProjection) }
            bufferedProjection = nil
        }

        /// Waits for the existing production coordinator barrier after a real native control submits.
        func drain() async throws {
            let drain = try #require(coordinator?.drainNativeIntents)
            try await drain()
        }

        /// Public accessibility menu actions invoke the SwiftUI Picker binding with the chosen model.
        func choose(_ value: String, in picker: AXUIElement, field: String) async throws {
            let model = try #require(value.split(separator: ":").last).description
            try NativeCreationControlFixture.press(picker)
            var item: AXUIElement?
            try await wait {
                item = self.accessibilityDescendants(picker).first {
                    NativeCreationControlFixture.string($0, kAXRoleAttribute) == kAXMenuItemRole
                        && NativeCreationControlFixture.string($0, kAXTitleAttribute)?.contains(model) == true
                }
                return item != nil
            }
            _ = AXUIElementPerformAction(try #require(item), kAXPressAction as CFString)
            try await wait {
                (self.bufferedProjection?["projection"] as? [String: Any])?["settings"].flatMap { $0 as? [String: Any] }?[field] as? String == value
            }
        }

        /// System popup roles identify only the two model selectors in this fixture's settings window.
        func pickers() async throws -> [AXUIElement] {
            let elements = try await NativeCreationControlFixture.elements(in: window)
            let result = elements.filter { NativeCreationControlFixture.string($0, kAXRoleAttribute) == kAXPopUpButtonRole }
            try #require(result.count == 2)
            return result
        }

        /// Menu traversal starts at the pressed popup, avoiding unrelated application or menu-bar commands.
        private func accessibilityDescendants(_ element: AXUIElement, depth: Int = 0) -> [AXUIElement] {
            guard depth < 12 else { return [] }
            var children: CFTypeRef?
            _ = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &children)
            return [element] + (children as? [AXUIElement] ?? []).flatMap { accessibilityDescendants($0, depth: depth + 1) }
        }

        /// Public control values identify this fixture's custom provider without private SwiftUI classes.
        func field(value: String) async throws -> NSTextField {
            var result: NSTextField?
            try await wait { result = self.descendants(self.window.contentView).compactMap { $0 as? NSTextField }.first { $0.isEditable && $0.stringValue == value }; return result != nil }
            return try #require(result)
        }

        /// Native delegate delivery exercises the production TextField binding for each synthetic edit.
        func enter(_ text: String, in field: NSTextField) {
            window.makeFirstResponder(field)
            field.stringValue = text
            field.delegate?.controlTextDidChange?(Notification(name: NSControl.textDidChangeNotification, object: field))
        }

        /// Disk assertions follow a completed real settings close, never a mocked saver call.
        func readSettings() throws -> HostJSON {
            try JSONDecoder().decode(HostJSON.self, from: Data(contentsOf: root.appendingPathComponent("settings.json")))
        }

        /// A bounded deadline turns missing controls or owner transitions into explicit verification failure.
        func wait(_ predicate: () -> Bool) async throws {
            let deadline = ContinuousClock.now.advanced(by: .seconds(12))
            while !predicate() && ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(30)) }
            try #require(predicate(), "隔离设置控件或生产 owner 未就绪")
        }

        /// All traversal is limited to the window owned by this test.
        private func descendants(_ view: NSView?) -> [NSView] {
            guard let view else { return [] }
            return [view] + view.subviews.flatMap { descendants($0) }
        }

        /// Cancels the actual page before removing the two windows and their disposable settings root.
        func remove() {
            coordinator?.invalidateSession()
            webView.stopLoading()
            webView.configuration.userContentController.removeScriptMessageHandler(forName: "plotweaveHost")
            webView.configuration.userContentController.removeScriptMessageHandler(forName: WebCanvasCoordinator.bridgeName)
            for owned in [window, webWindow] { owned.close(); owned.contentView = nil }
            try? FileManager.default.removeItem(at: root)
        }
    }
}
