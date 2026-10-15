import AppKit
import SwiftUI
import Testing
import WebKit
@testable import PlotWeaveNative

/// Real shell presentation consumes explicit node-property requests without reviving stale route or page state.
@MainActor
@Suite(.serialized, WebKitTestIsolation())
struct NativeShellNodeSettingsTests {
    /// Different targets and repeated requests for one target each reopen a manually collapsed inspector.
    @Test func explicitNodeRequestsReopenTheSameNativeInspector() async throws {
        let fixture = try await Fixture.mount()
        defer { fixture.close() }
        try fixture.publish(sequence: 1, request: 0, node: nil)
        try await fixture.settle()
        fixture.layout.inspectorVisible = false
        try fixture.publish(sequence: 2, request: 1, node: "node-a")
        try await fixture.settle()
        #expect(fixture.layout.inspectorVisible)
        #expect(fixture.state.editor["selected"]?["id"]?.string == "node-a")
        fixture.layout.inspectorVisible = false
        try fixture.publish(sequence: 3, request: 2, node: "node-b")
        try await fixture.settle()
        #expect(fixture.layout.inspectorVisible)
        #expect(fixture.state.editor["selected"]?["id"]?.string == "node-b")
        fixture.layout.inspectorVisible = false
        try fixture.publish(sequence: 4, request: 3, node: "node-b")
        try await fixture.settle()
        #expect(fixture.layout.inspectorVisible, "A fresh request must reopen the same target after native collapse")
        #expect(Self.webView(in: fixture.window.contentView) === fixture.webView)
    }

    /// Ordinary changes, out-of-order events and cross-project projections cannot turn a collapsed preference into an edit request.
    @Test func unrelatedOrRejectedProjectionsKeepInspectorCollapsed() async throws {
        let fixture = try await Fixture.mount()
        defer { fixture.close() }
        try fixture.publish(sequence: 1, request: 1, node: "node-a")
        try await fixture.settle()
        fixture.layout.inspectorVisible = false
        try fixture.publish(sequence: 2, request: 1, node: "node-a", title: "ordinary projection")
        try await fixture.settle()
        #expect(!fixture.layout.inspectorVisible)
        try fixture.publish(sequence: 1, request: 9, node: "node-b")
        try await fixture.settle()
        #expect(!fixture.layout.inspectorVisible)
        #expect(fixture.state.editor["selected"]?["id"]?.string == "node-a")
        try fixture.publish(sequence: 3, request: 2, node: "node-b", editorProject: "other-project")
        try await fixture.settle()
        #expect(fixture.state.editor == .null)
        #expect(!fixture.layout.inspectorVisible)
        try fixture.publish(sequence: 4, request: 2, node: "node-b")
        try await fixture.settle()
        #expect(!fixture.layout.inspectorVisible, "Restoring a filtered editor snapshot is not a fresh edit request")
    }

    /// Route, project and page-generation restoration establish a baseline rather than replaying old property targets.
    @Test func restoredRoutesAndPageGenerationsDoNotReplayRequests() async throws {
        let fixture = try await Fixture.mount()
        defer { fixture.close() }
        try fixture.publish(sequence: 1, request: 1, node: "node-a")
        try await fixture.settle()
        fixture.layout.inspectorVisible = false
        try fixture.publish(sequence: 2, request: 1, node: "node-a", route: "settings")
        try await fixture.settle()
        try fixture.publish(sequence: 3, request: 1, node: "node-b")
        try await fixture.settle()
        #expect(!fixture.layout.inspectorVisible)
        fixture.state.invalidate("isolated page reset")
        try await fixture.settle()
        fixture.session = "replacement-page"
        fixture.state.beginSession(fixture.session)
        try fixture.publish(sequence: 1, request: 8, node: "node-b")
        try await fixture.settle()
        #expect(!fixture.layout.inspectorVisible)
        try fixture.publish(sequence: 2, request: 9, node: "node-b")
        try await fixture.settle()
        #expect(fixture.layout.inspectorVisible)
        fixture.layout.inspectorVisible = false
        try fixture.publish(sequence: 3, request: 10, node: "node-a", project: "replacement-project")
        try await fixture.settle()
        #expect(!fixture.layout.inspectorVisible)
        #expect(Self.webView(in: fixture.window.contentView) === fixture.webView)
    }

    /// Older projections without a request counter retain explicit target-change behavior without reopening on ordinary content updates.
    @Test func legacyTargetChangesRetainInspectorCompatibility() async throws {
        let fixture = try await Fixture.mount()
        defer { fixture.close() }
        try fixture.publish(sequence: 1, request: nil, node: nil)
        try await fixture.settle()
        fixture.layout.inspectorVisible = false
        try fixture.publish(sequence: 2, request: nil, node: "node-a")
        try await fixture.settle()
        #expect(fixture.layout.inspectorVisible)
        fixture.layout.inspectorVisible = false
        try fixture.publish(sequence: 3, request: nil, node: "node-a", title: "ordinary legacy update")
        try await fixture.settle()
        #expect(!fixture.layout.inspectorVisible)
        try fixture.publish(sequence: 4, request: nil, node: "node-b")
        try await fixture.settle()
        #expect(fixture.layout.inspectorVisible)
    }

    /// The fixture hosts the local canvas demo with services disabled, so no production data root is reachable.
    @MainActor private final class Fixture {
        /// Injected native visibility is observed through the real root rather than a mirrored test reducer.
        let layout = ShellLayoutState()
        /// Synthetic projections enter the same ordered application consumer used by production.
        let state = NativeApplicationState()
        /// Only this disposable hosting window is closed during teardown.
        let window: NSWindow
        /// Disabled storage services and an independent quit owner prevent production data or lifecycle effects.
        let services = NativeHostServices(dataRoot: nil, quit: HostQuitController())
        /// The actual coordinator generation gates every synthetic envelope.
        var session = ""
        /// Captured WebKit identity survives every property-panel transition.
        var webView: WKWebView?

        /// A disposable native window exercises the actual SwiftUI onChange and inspector composition.
        init() {
            window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 750),
                              styleMask: [.titled], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.level = .floating
            window.contentView = NSHostingView(rootView: NativeShellRoot(
                layout: layout, demoMode: true, services: services, application: state
            ))
            window.contentView?.layoutSubtreeIfNeeded()
            window.orderFrontRegardless()
        }

        /// The local WKWebView handshake completes before synthetic projections enter its real native page owner.
        static func mount() async throws -> Fixture {
            let fixture = Fixture()
            do {
                let deadline = ContinuousClock.now.advanced(by: .seconds(12))
                while ContinuousClock.now < deadline {
                    if let webView = NativeShellNodeSettingsTests.webView(in: fixture.window.contentView), !webView.isLoading,
                       let coordinator = webView.navigationDelegate as? WebCanvasCoordinator {
                        let count = try await webView.evaluateJavaScript("document.querySelectorAll('.react-flow__node').length") as? Int
                        if count == 9 {
                            fixture.webView = webView
                            fixture.session = coordinator.sessionId
                            return fixture
                        }
                    }
                    try await Task.sleep(for: .milliseconds(50))
                }
                throw HostFailure(code: "PW_TEST_CANVAS_TIMEOUT", message: "Isolated shell canvas did not finish its local handshake")
            } catch {
                fixture.close()
                throw error
            }
        }

        /// Only semantic read-only projection fields vary; no editor command or service request is sent.
        func publish(sequence: Int, request: Int?, node: String?, route: String = "editor",
                     project: String = "fixture-project", editorProject: String? = nil,
                     title: String = "fixture dialogue") throws {
            let selected: Any = node.map { ["id": $0, "type": "dialogue", "data": ["title": title, "lines": []]] as [String: Any] } ?? NSNull()
            var editor: [String: Any] = ["projectId": editorProject ?? project, "editingNodeId": node as Any? ?? NSNull(),
                                         "selected": selected, "aiOpen": false]
            if let request { editor["nodeSettingsRequest"] = request }
            try state.receiveProjection([
                "protocolVersion": 1, "sessionId": session, "sequence": sequence,
                "projection": [
                    "app": ["route": route, "project": ["id": project, "name": "fixture"]],
                    "editor": editor
                ]
            ])
        }

        /// Yielding lets the real SwiftUI observer apply each distinct transition before the next one.
        func settle() async throws { try await Task.sleep(for: .milliseconds(400)) }

        /// Releasing the native composition tears down only this fixture's hosted page and appearance observers.
        func close() { window.close(); window.contentView = nil }
    }

    /// The stable WebKit identity proves property-panel changes do not recreate the editing host.
    private static func webView(in view: NSView?) -> WKWebView? {
        guard let view else { return nil }
        if let webView = view as? WKWebView { return webView }
        for child in view.subviews { if let found = webView(in: child) { return found } }
        return nil
    }
}
