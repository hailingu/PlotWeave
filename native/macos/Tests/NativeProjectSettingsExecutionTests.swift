import AppKit
import SwiftUI
import Testing
import WebKit
@testable import PlotWeaveNative

/// Project settings controls target the production Web document and persist through actual native storage.
@MainActor
@Suite(.serialized, WebKitTestIsolation())
struct NativeProjectSettingsExecutionTests {
    /// The actual native create action persists a new entity and exposes that immutable row's detail form.
    @Test func nativeCreateAndSelectionPersistThroughWebOwner() async throws {
        let fixture = Fixture()
        do {
            let id = try await fixture.start()
            fixture.controls.mount(NativeProjectSettingsView(state: fixture.state, projectId: id))
            try await fixture.controls.press("新增")
            try await NativeCoverageWindow.wait("Native-created character was not projected") {
                fixture.state.editor["settings"]?["characters"]?.array.count == 1
            }
            let entity = try #require(fixture.state.editor["settings"]?["characters"]?.array.first)
            let entityID = try #require(entity["id"]?.string)
            let name = try #require(entity["name"]?.string)
            try await fixture.controls.press("编辑「\(name)」")
            let controls = try await fixture.controls.strings()
            #expect(controls.contains(name) && controls.contains("名称"))
            _ = try await fixture.state.request("app.home")
            try await NativeCoverageWindow.wait("Home transition did not finish") { fixture.state.route == "home" }
            let saved = try await fixture.persistedCharacter(projectID: id, entityID: entityID, name: name)
            #expect(saved["settings"]?["characters"]?[entityID]?["name"]?.string == name)
            _ = try await fixture.state.request("app.open", args: ["id": .string(id)])
            try await NativeCoverageWindow.wait("Saved native-created character did not reopen") {
                fixture.state.editor["settings"]?["characters"]?.array.first?["id"]?.string == entityID
                    && fixture.state.editor["settings"]?["characters"]?.array.first?["name"]?.string == name
            }
            await fixture.close()
        } catch { await fixture.close(); throw error }
    }

    /// Owns one isolated production page and a separate control window; no fixture page replaces the document writer.
    @MainActor private final class Fixture {
        /// Only this fresh temporary root can receive project writes.
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-project-settings-ui-" + UUID().uuidString)
        /// Real native intents and read projections share the production owner.
        let state = NativeApplicationState()
        /// The actual ready handshake determines page readiness.
        let canvas = WebCanvasState()
        /// Storage and command routing use one injected native service root.
        let services: NativeHostServices
        /// Native settings controls have their own disposable visible window.
        let controls = NativeCoverageWindow(Text("fixture"))
        /// The production page remains visible for its frame-driven handshake.
        let webWindow = NativeCoverageWindow(Text("fixture"), width: 900, height: 600)
        /// Retained coordination is explicitly released before service teardown.
        private var coordinator: WebCanvasCoordinator?
        /// One production Web view owns the editable document throughout the test.
        private var webView: WKWebView?

        /// Service construction remains lazy; opening the page uses the same native router as the application.
        init() { services = NativeHostServices(dataRoot: root, quit: HostQuitController()) }

        /// Bounded readiness checks wait for the actual canvas and home load before issuing project intents.
        func start() async throws -> String {
            let configuration = WKWebViewConfiguration()
            let view = try IsolatedWebViewFixture.makeWebView(frame: NSRect(x: 0, y: 0, width: 900, height: 600), configuration: configuration)
            webView = view
            let owner = WebCanvasCoordinator(state: canvas, appearance: CanvasAppearanceState(), services: services,
                onProjection: { [weak state] envelope in
                    do { try state?.receiveProjection(envelope) }
                    catch { Issue.record("Production settings projection failed: \(error)") }
                }, onConnection: { [weak state] in state?.connect($0) })
            coordinator = owner
            configuration.userContentController.add(owner, name: WebCanvasCoordinator.bridgeName)
            view.navigationDelegate = owner
            webWindow.window.contentView = view
            owner.loadCanvas(into: view)
            try await NativeCoverageWindow.wait("Production canvas did not reach ready home") { self.canvas.phase == .ready && self.state.route == "home" && self.state.app["loading"] == .bool(false) }
            let store = try #require(services.projectStore)
            let metadata = try await store.invoke(command: "create_project", args: ["name": .string("设定控件隔离项目")])
            let id = try #require(metadata["id"]?.string)
            _ = try await state.request("app.open", args: ["id": .string(id)])
            try await NativeCoverageWindow.wait("Production project did not open") { self.state.route == "editor" && self.state.projectId == id }
            return id
        }

        /// Home projection may precede asynchronous unmount saves; observe the actual durable entity receipt.
        func persistedCharacter(projectID: String, entityID: String, name: String) async throws -> HostJSON {
            let store = try #require(services.projectStore)
            let deadline = ContinuousClock.now.advanced(by: .seconds(12))
            var saved = try await store.invoke(command: "load_project", args: ["id": .string(projectID)])
            while saved["settings"]?["characters"]?[entityID]?["name"]?.string != name, ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(20))
                saved = try await store.invoke(command: "load_project", args: ["id": .string(projectID)])
            }
            try #require(saved["settings"]?["characters"]?[entityID]?["name"]?.string == name, "Native-created character was not persisted before the deadline")
            return saved
        }

        /// Stop Web delivery and drain real service work before removing only this fixture's files.
        func close() async {
            controls.close()
            webView?.stopLoading()
            webView?.configuration.userContentController.removeScriptMessageHandler(forName: WebCanvasCoordinator.bridgeName)
            webView?.navigationDelegate = nil
            webWindow.close()
            coordinator = nil
            webView = nil
            await services.close()
            try? FileManager.default.removeItem(at: root)
        }
    }
}
