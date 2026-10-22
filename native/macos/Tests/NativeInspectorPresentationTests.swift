import AppKit
import ApplicationServices
import Observation
import SwiftUI
import Testing
@testable import PlotWeaveNative

/// Actual native controls protect the shared inspector layout contract in UI design §4.8.
@MainActor
@Suite(.serialized)
struct NativeInspectorPresentationTests {
    /// Every node kind exposes two compact actions on the same visible footer row.
    @Test(arguments: ["scene", "beat", "dialogue", "branch", "shot", "image"])
    func nodeActionsShareOneFooterRow(type: String) async throws {
        let (window, state) = try makeWindow(type: type)
        defer { window.close(); window.contentView = nil }
        let copy = try await NativeCreationControlFixture.button(in: window, named: "复制节点")
        let delete = try await NativeCreationControlFixture.button(in: window, named: "删除节点")
        let copyFrame = try NativeCreationControlFixture.frame(copy)
        let deleteFrame = try NativeCreationControlFixture.frame(delete)
        #expect(abs(copyFrame.midY - deleteFrame.midY) < 1)
        #expect(copyFrame.maxX <= deleteFrame.minX)
        #expect(try NativeCreationControlFixture.isEnabled(copy))
        #expect(try NativeCreationControlFixture.isEnabled(delete))
        #expect(state.error == nil)
        try savePreview(window, name: type)
    }

    /// Long editable text uses the full content width in both system appearances and column extremes.
    @Test(arguments: [CGFloat(300), CGFloat(640)], [NSAppearance.Name.aqua, .darkAqua])
    func longTextUsesColumnWidth(width: CGFloat, appearance: NSAppearance.Name) async throws {
        let (window, state) = try makeWindow(type: "scene", width: width)
        defer { window.close(); window.contentView = nil }
        window.appearance = NSAppearance(named: appearance)
        let input = try await NativeCreationControlFixture.element(in: window, named: "梗概", roles: [kAXTextFieldRole, kAXTextAreaRole])
        let frame = try NativeCreationControlFixture.frame(input)
        #expect(frame.width >= (try await contentColumnWidth(in: window)) - 64)
        #expect(NativeCreationControlFixture.string(input, kAXValueAttribute) == state.editor["selected"]?["data"]?["synopsis"]?.string)
        let interior = try await NativeCreationControlFixture.element(in: window, named: "内景", roles: [kAXCheckBoxRole])
        #expect(abs(try NativeCreationControlFixture.frame(interior).maxX - frame.maxX) < 2)
        #expect(state.error == nil)
        try savePreview(window, name: "scene-\(Int(width))-\(appearance.rawValue)")
    }

    /// Legacy scrollers consume their observed width; overlay scrollers leave the content column unchanged.
    private func contentColumnWidth(in window: NSWindow) async throws -> CGFloat {
        let elements = try await NativeCreationControlFixture.elements(in: window)
        let area = try #require(elements.first { NativeCreationControlFixture.string($0, kAXRoleAttribute) == kAXScrollAreaRole })
        let width = try NativeCreationControlFixture.frame(area).width
        guard NSScroller.preferredScrollerStyle == .legacy,
              let bar = elements.first(where: {
                  NativeCreationControlFixture.string($0, kAXRoleAttribute) == kAXScrollBarRole
                      && NativeCreationControlFixture.string($0, kAXOrientationAttribute) == kAXVerticalOrientationValue
              }) else { return width }
        return width - (try NativeCreationControlFixture.frame(bar).width)
    }

    /// Growing a stable-ID list scrolls content without moving or hiding the captured node's actions.
    @Test func largeListKeepsActionsVisible() async throws {
        let (window, state) = try makeWindow(type: "branch", width: 300)
        defer { window.close(); window.contentView = nil }
        let before = try NativeCreationControlFixture.frame(await NativeCreationControlFixture.button(in: window, named: "复制节点"))
        let options = (0..<30).map { ["id": "option-\($0)", "label": "选项 \($0)"] }
        try receiveSelection(state, type: "branch", data: ["prompt": "林晚是否发现真相？", "options": options], sequence: 2)
        let copy = try await NativeCreationControlFixture.button(in: window, named: "复制节点")
        let after = try NativeCreationControlFixture.frame(copy)
        #expect(before == after)
        #expect(try NativeCreationControlFixture.isEnabled(copy))
        #expect(state.error == nil)
        try savePreview(window, name: "branch-long-list")
    }

    /// Broken references remain explicit diagnostics instead of disappearing inside the new content groups.
    @Test func brokenReferencesStayVisibleWithoutEditing() async throws {
        let (window, state) = try makeWindow(type: "scene")
        defer { window.close(); window.contentView = nil }
        try receiveSelection(state, type: "scene", data: ["name": "雨夜天台", "characterIds": ["missing-character"]], sequence: 2)
        let scene = try await NativeCreationControlFixture.elements(in: window)
        #expect(scene.contains { NativeCreationControlFixture.string($0, kAXValueAttribute) == "失效角色引用 · missing-character" })
        try receiveSelection(state, type: "shot", data: ["shotNo": 1, "refs": [["id": "ref", "kind": "audio", "assetId": "missing-asset"]]], sequence: 3)
        let shot = try await NativeCreationControlFixture.elements(in: window)
        #expect(shot.contains { NativeCreationControlFixture.string($0, kAXValueAttribute) == "失效资产 · missing-asset" })
        #expect(state.error == nil)
        try savePreview(window, name: "shot-missing-asset")
    }

    /// Running and failed generation retain the original cancel and restart actions after restyling.
    @Test func generationActionsFollowProjectedJobState() async throws {
        let (window, state) = try makeWindow(type: "image")
        defer { window.close(); window.contentView = nil }
        try receiveSelection(state, type: "image", data: ["prompt": "雨夜天台"], sequence: 2, job: ["status": "running"])
        let cancel = try await NativeCreationControlFixture.button(in: window, named: "取消生成")
        #expect(try NativeCreationControlFixture.isEnabled(cancel))
        try receiveSelection(state, type: "image", data: ["prompt": "雨夜天台"], sequence: 3, job: ["status": "failed", "message": "合成失败诊断"])
        let retry = try await NativeCreationControlFixture.button(in: window, named: "生成图片")
        #expect(try NativeCreationControlFixture.isEnabled(retry))
        let elements = try await NativeCreationControlFixture.elements(in: window)
        #expect(elements.contains { NativeCreationControlFixture.string($0, kAXValueAttribute) == "合成失败诊断" })
        #expect(state.error == nil)
        try savePreview(window, name: "image-failed-job")
    }

    /// Synthetic read-only projections exercise production views without a Web session or user data root.
    private func makeWindow(type: String, width: CGFloat = 360) throws -> (NSWindow, NativeApplicationState) {
        let state = NativeApplicationState()
        state.beginSession("inspector-presentation")
        try receiveSelection(state, type: type, data: ["name": "雨夜天台", "prompt": "林晚是否发现真相？", "tone": "压抑渐强",
            "synopsis": "林晚在旧公寓找到父亲留下的第二张照片，两条支线的真相在此汇合。",
            "time": "夜", "weather": "雨", "sceneNo": 3, "shotNo": 1, "characterIds": ["lin"],
            "lines": [["id": "line", "kind": "line", "speaker": "lin", "side": "left", "text": "那晚，我也在旧公寓。", "vo": false]],
            "options": [["id": "truth", "label": "坦白"], ["id": "hide", "label": "隐瞒"]],
            "refs": [["id": "character", "kind": "character", "label": "林晚垫图"]]])
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: 640),
                              styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: NativeInspectorView(state: state).background(Color(nsColor: .windowBackgroundColor)))
        window.orderFront(nil)
        return (window, state)
    }

    /// Projection updates follow the application's session and sequence filter rather than mutating UI drafts.
    private func receiveSelection(_ state: NativeApplicationState, type: String, data: [String: Any], sequence: Int = 1, job: [String: Any] = [:]) throws {
        try state.receiveProjection([
            "protocolVersion": 1, "sessionId": "inspector-presentation", "sequence": sequence,
            "projection": ["app": ["route": "editor", "loading": false,
                "project": ["id": "preview", "name": "检查器核对"]],
                "editor": ["projectId": "preview", "selected": ["id": "node", "type": type,
                    "data": data],
                    "settings": ["characters": [["id": "lin", "name": "林晚"], ["id": "chen", "name": "陈默"]], "locations": []]],
                "image": ["projectId": "preview", "jobs": ["node": job], "models": []]]
        ])
    }

    /// A hidden inspector pane must not build the per-selection field tree: macOS
    /// evaluates `.inspector` content eagerly, and first-drag selection commits used
    /// to instantiate the hidden field controls (issue #544).
    @Test func hiddenPaneDoesNotBuildNodeFieldsForSelection() async throws {
        let mounted = try makeVisibilityWindow(sequence: 1, aiOpen: false, selected: nil)
        defer { mounted.window.close(); mounted.window.contentView = nil }
        mounted.pane.inspector = false
        try await settlePane()
        try publishEditorState(mounted.state, sequence: 2, aiOpen: false,
            selected: ["id": "node", "type": "scene", "data": ["name": "雨夜天台", "synopsis": "梗概草稿"]])
        try await settlePane()
        #expect(Self.textInputs(in: mounted.window.contentView).isEmpty, "隐藏的检查器面板不得为选中实例化文本输入控件")
        mounted.pane.inspector = true
        try await settlePane()
        #expect(!Self.textInputs(in: mounted.window.contentView).isEmpty, "恢复可见后仍须呈现选中节点的字段")
    }

    /// The AI pane's native draft survives collapsing and restoring the inspector.
    @Test func hiddenPaneKeepsAiDraftMounted() async throws {
        let mounted = try makeVisibilityWindow(sequence: 1, aiOpen: true)
        defer { mounted.window.close(); mounted.window.contentView = nil }
        let composer = try await awaitComposer(in: mounted.window)
        composer.string = "未发送草稿"
        composer.didChangeText()
        mounted.pane.inspector = false
        try await settlePane()
        mounted.pane.inspector = true
        try await settlePane()
        let restored = try await awaitComposer(in: mounted.window)
        #expect(ObjectIdentifier(restored) == ObjectIdentifier(composer), "AI 面板在收起期间保持挂载")
        #expect(restored.string == "未发送草稿", "收起再展开不得丢失 AI 草稿")
    }

    /// Editor autosave failures stay visible while the AI pane is active (PR #578 review).
    @Test func aiPaneKeepsEditorSaveErrorVisible() async throws {
        let mounted = try makeVisibilityWindow(sequence: 1, aiOpen: true)
        defer { mounted.window.close(); mounted.window.contentView = nil }
        try publishEditorState(mounted.state, sequence: 2, aiOpen: true, selected: nil,
            saveError: "保存失败：磁盘已满")
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        var found = false
        while ContinuousClock.now < deadline && !found {
            let elements = try await NativeCreationControlFixture.elements(in: mounted.window)
            found = elements.contains {
                NativeCreationControlFixture.string($0, kAXValueAttribute) == "保存失败：磁盘已满"
            }
            if !found { try await Task.sleep(for: .milliseconds(50)) }
        }
        #expect(found, "AI 面板激活时文档保存错误横幅仍须可见")
    }

    /// Incomplete numeric drafts survive collapsing and restoring the inspector (PR #578 review).
    @Test func hiddenPaneKeepsIncompleteNumericDraft() async throws {
        let mounted = try makeVisibilityWindow(sequence: 1, aiOpen: false)
        defer { mounted.window.close(); mounted.window.contentView = nil }
        try publishEditorState(mounted.state, sequence: 2, aiOpen: false,
            selected: ["id": "node", "type": "scene", "data": ["name": "雨夜天台", "sceneNo": 3]])
        let field = try await awaitField(mounted.window, label: "场次")
        try #require(AXUIElementSetAttributeValue(field, kAXValueAttribute as CFString, "3." as CFTypeRef) == .success)
        try await settlePane()
        mounted.pane.inspector = false
        try await settlePane()
        mounted.pane.inspector = true
        try await settlePane()
        let restored = try await awaitField(mounted.window, label: "场次")
        #expect(NativeCreationControlFixture.string(restored, kAXValueAttribute) == "3.",
            "收起再展开不得丢弃未完成的数字草稿（销毁路径会从投影值恢复为 3）")
    }

    /// Reopening after a hidden selection must retain the newly mounted node's draft on later collapses.
    @Test(arguments: [false, true])
    func reopenedPaneKeepsNumericDraftAfterHiddenSelection(hadSelection: Bool) async throws {
        let initial: [String: Any]? = hadSelection
            ? ["id": "previous", "type": "scene", "data": ["name": "旧节点", "sceneNo": 1]] : nil
        let mounted = try makeVisibilityWindow(sequence: 1, aiOpen: false, selected: initial)
        defer { mounted.window.close(); mounted.window.contentView = nil }
        try await settlePane()
        mounted.pane.inspector = false
        try await settlePane()
        try publishEditorState(mounted.state, sequence: 2, aiOpen: false,
            selected: ["id": "current", "type": "scene", "data": ["name": "新节点", "sceneNo": 3]])
        try await settlePane()
        #expect(Self.textInputs(in: mounted.window.contentView).isEmpty, "隐藏时切换选择不得创建新字段树")
        mounted.pane.inspector = true
        try await settlePane()
        let field = try await awaitField(mounted.window, label: "场次")
        #expect(NativeCreationControlFixture.string(field, kAXValueAttribute) == "3")
        try #require(AXUIElementSetAttributeValue(field, kAXValueAttribute as CFString, "3." as CFTypeRef) == .success)
        try await settlePane()
        for _ in 0..<2 {
            mounted.pane.inspector = false
            try await settlePane()
            mounted.pane.inspector = true
            try await settlePane()
            let restored = try await awaitField(mounted.window, label: "场次")
            #expect(NativeCreationControlFixture.string(restored, kAXValueAttribute) == "3.",
                "隐藏时换选后重新展开的字段也须跨后续收展保留未完成数字草稿")
        }
    }

    /// Finds a labeled text input once it has mounted.
    private func awaitField(_ window: NSWindow, label: String) async throws -> AXUIElement {
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while ContinuousClock.now < deadline {
            let elements = try await NativeCreationControlFixture.elements(in: window)
            if let field = elements.first(where: {
                NativeCreationControlFixture.string($0, kAXRoleAttribute) == kAXTextFieldRole
                    && (NativeCreationControlFixture.string($0, kAXTitleAttribute) == label
                        || NativeCreationControlFixture.string($0, kAXDescriptionAttribute) == label)
            }) { return field }
            try await Task.sleep(for: .milliseconds(20))
        }
        throw HostFailure(code: "PW_TEST_FIELD_TIMEOUT", message: "检查器可见性夹具的「\(label)」输入未就绪")
    }

    /// Verification attachments render the actual production view with synthetic content only.
    private func savePreview(_ window: NSWindow, name: String) throws {
        let view = try #require(window.contentView)
        let bitmap = try #require(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: bitmap)
        let png = try #require(bitmap.representation(using: .png, properties: [:]))
        Attachment.record(png, named: name + ".png")
    }

    // MARK: visibility helpers

    /// In-place visibility flips mirror the shell's layout state without tearing down the hosted tree.
    @Observable final class PaneVisibility { var inspector = true }

    /// Hosts the production inspector view behind an observable visibility flag.
    private struct InspectorVisibilityHarness: View {
        let state: NativeApplicationState
        let pane: PaneVisibility
        var body: some View { NativeInspectorView(state: state, visible: pane.inspector) }
    }

    /// Mounts the real inspector with an editor projection and a controllable pane flag.
    private func makeVisibilityWindow(
        sequence: Int, aiOpen: Bool,
        selected: [String: Any]? = ["id": "node", "type": "scene", "data": ["name": "雨夜天台"]]
    ) throws -> (window: NSWindow, pane: PaneVisibility, state: NativeApplicationState) {
        let state = NativeApplicationState()
        state.beginSession("inspector-visibility")
        try publishEditorState(state, sequence: sequence, aiOpen: aiOpen, selected: selected)
        let pane = PaneVisibility()
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 360, height: 640),
                              styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: InspectorVisibilityHarness(state: state, pane: pane))
        window.orderFront(nil)
        return (window, pane, state)
    }

    /// Editor-domain state reaches the view through the production projection receiver.
    private func publishEditorState(_ state: NativeApplicationState, sequence: Int, aiOpen: Bool, selected: [String: Any]?, saveError: String? = nil) throws {
        var editor: [String: Any] = ["projectId": "preview", "aiOpen": aiOpen]
        if let selected { editor["selected"] = selected }
        if let saveError { editor["saveError"] = saveError }
        try state.receiveProjection([
            "protocolVersion": 1, "sessionId": "inspector-visibility", "sequence": sequence,
            "projection": ["app": ["route": "editor", "loading": false,
                "project": ["id": "preview", "name": "检查器可见性"]],
                "editor": editor,
                "ai": ["projectId": "preview"], "image": ["projectId": "preview"], "settings": ["models": []]],
        ])
    }

    /// Lets an observation-driven SwiftUI update land before asserting the AppKit tree.
    private func settlePane() async throws {
        try await Task.sleep(for: .milliseconds(150))
    }

    /// Finds the editable AI composer once it has mounted.
    private func awaitComposer(in window: NSWindow) async throws -> NSTextView {
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while ContinuousClock.now < deadline {
            if let composer = Self.textInputs(in: window.contentView).compactMap({ $0 as? NSTextView }).first(where: \.isEditable) {
                return composer
            }
            try await Task.sleep(for: .milliseconds(20))
        }
        throw HostFailure(code: "PW_TEST_COMPOSER_TIMEOUT", message: "检查器可见性夹具的草稿输入未就绪")
    }

    /// Collects text input controls from the fixture's own public AppKit tree.
    private static func textInputs(in view: NSView?) -> [NSView] {
        guard let view else { return [] }
        let inputs = [view as? NSTextField, view as? NSTextView].compactMap { $0 }
        return inputs + view.subviews.flatMap { textInputs(in: $0) }
    }
}
