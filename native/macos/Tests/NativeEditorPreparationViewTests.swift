import AppKit
import ApplicationServices
import SwiftUI
import Testing
@testable import PlotWeaveNative

/// Project-entry preparation builds actual controls before selection and retains them when an unselected node is dragged.
@MainActor
@Suite(.serialized)
struct NativeEditorPreparationViewTests {
    /// A seed is laid out while selection stays absent; selecting a different node reuses the prepared controls.
    @Test func unselectedProjectPreparesControlsBeforeAllowingEditing() async throws {
        let state = NativeApplicationState()
        state.beginSession("preparation-view")
        try publish(state, sequence: 1)
        #expect(state.editorPreparation.pending)
        let host = NativeCoverageWindow(NativeInspectorView(state: state).overlay { NativeEditorPreparationOverlay(state: state) }, width: 360, height: 640)
        defer { host.close() }
        try await NativeCoverageWindow.wait { !state.editorPreparation.pending }
        #expect(state.selectedNodeID == nil, "准备不能伪造文档选中或发送编辑命令")
        let prepared = Set(numberFields(host.window.contentView).map(ObjectIdentifier.init))
        try publish(state, sequence: 2, selected: "never-selected")
        let title = try await NativeCreationControlFixture.element(in: host.window, named: "名称", roles: [kAXTextFieldRole, kAXTextAreaRole])
        #expect(NativeCreationControlFixture.string(title, kAXValueAttribute) == "never-selected")
        #expect(prepared.contains(ObjectIdentifier(try #require(numberField(host.window.contentView)))), "未预选过的节点复用已经布局的字段控件")
        try await host.enter("3.", replacing: "3")
        try publish(state, sequence: 3)
        _ = try await host.strings()
        try publish(state, sequence: 4, selected: "never-selected")
        _ = try await host.strings()
        #expect(numberField(host.window.contentView)?.stringValue == "3", "清空选择后重新选择必须结束旧字段草稿生命周期")
    }

    /// Each prepared kind retains its own real controls and inactive kinds never receive a typed draft.
    @Test func changingNodeKindKeepsPreparedControlsAndDraftTargetsIsolated() async throws {
        let state = NativeApplicationState()
        state.beginSession("preparation-view")
        try publish(state, sequence: 1)
        let host = NativeCoverageWindow(NativeInspectorView(state: state).overlay { NativeEditorPreparationOverlay(state: state) }, width: 360, height: 640)
        defer { host.close() }
        try await NativeCoverageWindow.wait { !state.editorPreparation.pending }
        let before = Set(numberFields(host.window.contentView).map(ObjectIdentifier.init))
        #expect(before.count == 2)
        try publish(state, sequence: 2, selected: "unselected-shot", selectedType: "shot")
        _ = try await NativeCreationControlFixture.element(in: host.window, named: "镜号", roles: [kAXTextFieldRole])
        #expect(Set(numberFields(host.window.contentView).map(ObjectIdentifier.init)) == before)
        try await host.enter("3.", replacing: "3")
        let fields = numberFields(host.window.contentView)
        #expect(fields.first(where: \.isEnabled)?.stringValue == "3.")
        #expect(fields.first(where: { !$0.isEnabled })?.stringValue == "3")
        #expect(state.error == nil)
    }

    /// Collapsed inspectors keep the original no-field-construction guard even when a real seed is available.
    @Test func hiddenInspectorCompletesWithoutBuildingSeedFields() async throws {
        let state = NativeApplicationState()
        state.beginSession("preparation-view")
        try publish(state, sequence: 1)
        let host = NativeCoverageWindow(NativeInspectorView(state: state, visible: false), width: 360, height: 640)
        defer { host.close() }
        try await NativeCoverageWindow.wait { !state.editorPreparation.pending }
        #expect(numberField(host.window.contentView) == nil)
        #expect(state.selectedNodeID == nil)
    }

    /// A closed system inspector may never mount; a later matching snapshot must still release its shield.
    @Test(arguments: [false, true])
    func noNodePaneCompletesAfterItsSnapshotArrives(aiOpen: Bool) async throws {
        let state = NativeApplicationState()
        state.beginSession("preparation-view")
        try state.receiveProjection(["protocolVersion": 1, "sessionId": "preparation-view", "sequence": 1,
            "projection": ["app": ["route": "editor", "project": ["id": "fixture"]]]])
        #expect(state.editorPreparation.pending)
        let host = NativeCoverageWindow(NativeEditorPreparationOverlay(state: state, inspectorVisible: aiOpen))
        defer { host.close() }
        try publish(state, sequence: 2, aiOpen: aiOpen)
        try await NativeCoverageWindow.wait { !state.editorPreparation.pending }
        #expect(numberField(host.window.contentView) == nil, "没有挂载节点检查器也不能永远等待字段布局")
    }

    /// A detached probe must not report success on the following main turn.
    @Test func removingLayoutProbeCancelsItsPendingReceipt() async {
        var receipts = 0
        let host = NativeCoverageWindow(NativeLayoutReceipt { receipts += 1 }.frame(width: 100, height: 80))
        host.close()
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async { continuation.resume() }
        }
        #expect(receipts == 0)
    }

    /// An independent read-only project supplies one scene and one shot seed, never the full graph or a second writer.
    private func publish(_ state: NativeApplicationState, sequence: Int, selected: String? = nil, aiOpen: Bool = false, selectedType: String = "scene") throws {
        let seed: [String: Any] = ["id": "seed", "type": "scene", "data": ["name": "seed", "sceneNo": 3]]
        let shot: [String: Any] = ["id": "shot-seed", "type": "shot", "data": ["shotNo": 3, "refs": []]]
        var editor: [String: Any] = ["projectId": "fixture", "inspectorSeeds": [seed, shot], "aiOpen": aiOpen,
            "settings": ["characters": [], "locations": []]]
        if let selected {
            editor["selected"] = ["id": selected, "type": selectedType, "data": ["name": selected, "sceneNo": 3, "shotNo": 3]]
        }
        try state.receiveProjection([
            "protocolVersion": 1, "sessionId": "preparation-view", "sequence": sequence,
            "projection": ["app": ["route": "editor", "project": ["id": "fixture", "name": "准备夹具"]], "editor": editor]
        ])
    }

    /// Public control identity includes prepared inactive fields without relying on AX visibility.
    private func numberFields(_ view: NSView?) -> [NSTextField] {
        guard let view else { return [] }
        let own: [NSTextField]
        if let field = view as? NSTextField, field.isEditable, field.stringValue == "3" || field.stringValue == "3." { own = [field] }
        else { own = [] }
        return own + view.subviews.flatMap { numberFields($0) }
    }

    /// Existing scene-only assertions select the first matching fixture-owned numeric field.
    private func numberField(_ view: NSView?) -> NSTextField? {
        let fields = numberFields(view)
        return fields.first(where: \.isEnabled) ?? fields.first
    }
}
