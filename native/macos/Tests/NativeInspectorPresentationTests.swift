import AppKit
import ApplicationServices
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
        #expect(frame.width >= width - 64)
        #expect(NativeCreationControlFixture.string(input, kAXValueAttribute) == state.editor["selected"]?["data"]?["synopsis"]?.string)
        let interior = try await NativeCreationControlFixture.element(in: window, named: "内景", roles: [kAXCheckBoxRole])
        #expect(abs(try NativeCreationControlFixture.frame(interior).maxX - frame.maxX) < 2)
        #expect(state.error == nil)
        try savePreview(window, name: "scene-\(Int(width))-\(appearance.rawValue)")
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

    /// Verification attachments render the actual production view with synthetic content only.
    private func savePreview(_ window: NSWindow, name: String) throws {
        let view = try #require(window.contentView)
        let bitmap = try #require(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: bitmap)
        let png = try #require(bitmap.representation(using: .png, properties: [:]))
        Attachment.record(png, named: name + ".png")
    }
}
