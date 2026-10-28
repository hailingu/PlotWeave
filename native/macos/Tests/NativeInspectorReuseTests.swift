import AppKit
import ApplicationServices
import CoreFoundation
import SwiftUI
import Testing
@testable import PlotWeaveNative

/// Reusing a prepared inspector must keep controls mounted while resetting node-local drafts and project identity.
@MainActor
@Suite(.serialized)
struct NativeInspectorReuseTests {
    /// Equal numeric values must still discard an incomplete draft when the selected identity changes.
    @Test func sameKindSelectionReusesFieldsWithoutLeakingDrafts() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let first = try await fixture.numberField()
        try await fixture.host.enter("3.", replacing: "3")
        try await fixture.publish(id: "second", name: "第二个节点", sequence: 2)
        let second = try await fixture.numberField(value: "3")
        #expect(CFEqual(first, second), "同类型换选应复用已准备的真实输入控件，而非销毁重建")
        #expect(NativeCreationControlFixture.string(second, kAXValueAttribute) == "3", "相等的权威值也必须按节点身份丢弃旧草稿")
    }

    /// Changing projects ends the old form lifecycle even when node IDs and field values happen to match.
    @Test func projectSwitchDiscardsPreparedControls() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let first = try await fixture.numberField()
        try await fixture.publish(id: "first", name: "新项目节点", sequence: 2, project: "other")
        let second = try await fixture.numberField()
        #expect(!CFEqual(first, second), "字段控件的复用不得跨越项目身份")
    }

    /// Ordinary authoritative updates of the same node do not discard an unfinished numeric draft.
    @Test func sameNodeProjectionPreservesIncompleteDraft() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let first = try await fixture.numberField()
        try await fixture.host.enter("3.", replacing: "3")
        try await fixture.publish(id: "first", name: "相同节点新标题", sequence: 2)
        let second = try await fixture.numberField()
        #expect(CFEqual(first, second))
        #expect(NativeCreationControlFixture.string(second, kAXValueAttribute) == "3.")
    }

    /// A delayed numeric projection must not overwrite a newer draft while its actual input keeps focus (#933).
    @Test func delayedNumberProjectionPreservesFocusedDraft() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        try await fixture.focusNumber()
        try await fixture.host.enter("37", replacing: "3")
        try await NativeCoverageWindow.wait("聚焦编辑必须实际提交到原生命令边界") { fixture.state.error != nil }
        try await fixture.publish(id: "first", name: "迟到数字回执", sequence: 2, sceneNo: 7)
        let field = try await fixture.numberField(value: "37")
        #expect(NativeCreationControlFixture.string(field, kAXValueAttribute) == "37")
    }

    /// Every view and projection is local to this disposable window; no production host or data root is selected.
    @MainActor private final class Fixture {
        let state = NativeApplicationState()
        let host: NativeCoverageWindow
        var window: NSWindow { host.window }

        /// Mounts the real inspector with one selected scene and no command connection.
        init() throws {
            state.beginSession("inspector-reuse")
            host = NativeCoverageWindow(NativeInspectorView(state: state), width: 360, height: 640)
            try receive(id: "first", name: "第一个节点", sequence: 1, project: "project")
        }

        /// A visible changed title is the receipt that the new selection has reached actual controls.
        func publish(id: String, name: String, sequence: Int, project: String = "project", sceneNo: Int = 3) async throws {
            try receive(id: id, name: name, sequence: sequence, project: project, sceneNo: sceneNo)
            let deadline = ContinuousClock.now.advanced(by: .seconds(5))
            while ContinuousClock.now < deadline {
                let field = try await NativeCreationControlFixture.element(in: window, named: "名称", roles: [kAXTextFieldRole, kAXTextAreaRole])
                if NativeCreationControlFixture.string(field, kAXValueAttribute) == name { return }
                try await Task.sleep(for: .milliseconds(20))
            }
            throw HostFailure(code: "PW_TEST_INSPECTOR_UPDATE_TIMEOUT", message: "检查器未显示当前选中节点")
        }

        /// Synthetic snapshots exercise the real session/sequence receiver and equal numeric values.
        private func receive(id: String, name: String, sequence: Int, project: String, sceneNo: Int = 3) throws {
            try state.receiveProjection([
                "protocolVersion": 1, "sessionId": "inspector-reuse", "sequence": sequence,
                "projection": ["app": ["route": "editor", "project": ["id": project, "name": "复用夹具"]],
                    "editor": ["projectId": project, "selected": ["id": id, "type": "scene", "data": ["name": name, "sceneNo": sceneNo]],
                        "settings": ["characters": [], "locations": []]]]
            ])
        }

        /// Public assistive focus engages SwiftUI's FocusState before the test submits a numeric edit.
        func focusNumber() async throws {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            let field = try await numberField(value: "3")
            try #require(AXUIElementSetAttributeValue(field, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success)
            try await NativeCoverageWindow.wait("实际数字框必须成为编辑目标") { self.window.firstResponder is NSTextView }
        }

        /// Returns the actual native numeric input independently of its internal SwiftUI wrapper.
        func numberField(value: String? = nil) async throws -> AXUIElement {
            let field = try await NativeCreationControlFixture.element(in: window, named: "场次", roles: [kAXTextFieldRole])
            if let value {
                let deadline = ContinuousClock.now.advanced(by: .seconds(5))
                while NativeCreationControlFixture.string(field, kAXValueAttribute) != value && ContinuousClock.now < deadline {
                    try await Task.sleep(for: .milliseconds(20))
                }
                try #require(NativeCreationControlFixture.string(field, kAXValueAttribute) == value)
            }
            return field
        }

        /// Releasing the host tree also discards every test-local draft.
        func remove() { host.close() }
    }
}
