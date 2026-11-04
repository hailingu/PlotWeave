import AppKit
import ApplicationServices
import SwiftUI
import Testing
@testable import PlotWeaveNative

/// Read-only previews expose ordered, noninteractive information while the real action buttons retain their roles.
@MainActor
@Suite(.serialized, WebKitTestIsolation())
struct NativeAiPreviewListTests {
    /// Both supported appearances retain list semantics and wrap long summaries in a narrow native pane (#928).
    @Test(arguments: ["light", "dark"], [1, 3])
    func summariesAreAListAndPreserveActionControls(appearance: String, count: Int) async throws {
        let state = NativeApplicationState()
        state.beginSession("preview-list")
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 900),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.level = .floating
        window.appearance = NSAppearance(named: appearance == "dark" ? .darkAqua : .aqua)
        defer { window.close(); window.contentView = nil }
        try publish(state, sequence: 1, status: "pending", count: count)
        let hosting = NSHostingView(rootView: NativeAiView(state: state, projectId: "preview-fixture").background(Color(nsColor: .windowBackgroundColor)))
        window.contentView = hosting
        window.orderFrontRegardless()
        let elements = try await readyElements(in: window)
        try NativePresentationEvidenceFixture.record(hosting, name: "preview-list-\(appearance)-\(count)")
        let facts = elements.map { element in
            [kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute].map {
                NativeCreationControlFixture.string(element, $0) ?? ""
            }.joined(separator: " | ")
        }.joined(separator: "\n")
        try NativePresentationEvidenceFixture.record(Data(facts.utf8), named: "preview-ax-\(appearance)-\(count).txt")
        print("[preview-ax-\(appearance)]\n" + facts)
        let list = try #require(elements.first {
            [kAXListRole, kAXOutlineRole].contains(NativeCreationControlFixture.string($0, kAXRoleAttribute) ?? "")
        }, "纯摘要应向辅助技术呈现列表，而不是带编辑图标的普通组")
        let items = accessibilityDescendants(list)
        let labels = items.compactMap { NativeCreationControlFixture.string($0, kAXValueAttribute) }
        let expected = Array(summaries.prefix(count))
        #expect(labels.filter { expected.contains($0) } == expected)
        #expect(items.filter { NativeCreationControlFixture.string($0, kAXRoleAttribute) == kAXRowRole }.count == count)
        #expect(!items.contains { NativeCreationControlFixture.string($0, kAXRoleAttribute) == kAXButtonRole })
        #expect(!items.contains { NativeCreationControlFixture.string($0, kAXDescriptionAttribute)?.contains("编辑") == true })
        _ = try await NativeCreationControlFixture.button(in: window, named: "忽略")
        _ = try await NativeCreationControlFixture.button(in: window, named: "确认删除改动…")
        try publish(state, sequence: 2, status: "executed", count: count)
        let executed = try await readyElements(in: window, named: "已执行 · 可整批撤销")
        #expect(executed.contains { NativeCreationControlFixture.string($0, kAXValueAttribute) == "已执行 · 可整批撤销" })
        #expect(!executed.contains { NativeCreationControlFixture.string($0, kAXDescriptionAttribute) == "忽略" })
        try publish(state, sequence: 3, status: "pending", count: count, valid: false)
        _ = try await readyElements(in: window, named: "测试校验失败")
        let execute = try await NativeCreationControlFixture.button(in: window, named: "执行改动")
        #expect(try NativeCreationControlFixture.isEnabled(execute) == false)
    }

    /// A first AX read can expose only the hosting skeleton; wait for real preview controls before checking semantics.
    private func readyElements(in window: NSWindow, named name: String = "忽略") async throws -> [AXUIElement] {
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        repeat {
            window.contentView?.layoutSubtreeIfNeeded()
            let elements = try await NativeCreationControlFixture.elements(in: window)
            if elements.contains(where: { element in
                [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute].contains {
                    NativeCreationControlFixture.string(element, $0) == name
                }
            }) { return elements }
        } while ContinuousClock.now < deadline
        throw HostFailure(code: "PW_TEST_PREVIEW_LIST_TIMEOUT", message: "预览摘要和实际操作控件尚未就绪")
    }

    /// Different command types, including deletion, stay in their original validated order.
    private var summaries: [String] {
        ["断开起风与雨过天晴的连接", "创建一张标题很长的节奏卡，描述人物离开熟悉的街道并在暴雨中的路口重新作出选择", "连线：起风 → 雨过天晴"]
    }

    /// Synthetic projections exercise only presentation; no model, execution handler or persisted document is substituted.
    private func publish(_ state: NativeApplicationState, sequence: Double, status: String, count: Int, valid: Bool = true) throws {
        let items = Array(summaries.prefix(count)).enumerated().map {
            ["label": $0.element, "danger": $0.offset == 0] as [String: Any]
        }
        let validation: [String: Any] = ["ok": valid, "hasDeletes": valid, "commands": [],
                                        "issues": valid ? [] : [["message": "测试校验失败"]], "items": items]
        let entry: [String: Any] = ["id": 2, "kind": "msg", "role": "assistant", "text": "创建，连线",
                                   "card": ["status": status, "v": validation]]
        try state.receiveProjection([
            "protocolVersion": 1, "sessionId": "preview-list", "sequence": sequence,
            "projection": ["app": ["route": "editor", "project": ["id": "preview-fixture", "name": "列表呈现"]],
                           "ai": ["projectId": "preview-fixture", "ready": true, "busy": false, "thread": [entry]]]
        ])
    }

    /// List membership is read from the public AX tree without relying on SwiftUI's private hosting classes.
    private func accessibilityDescendants(_ element: AXUIElement, depth: Int = 0) -> [AXUIElement] {
        guard depth < 12 else { return [] }
        var value: CFTypeRef?
        AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value)
        let children = value as? [AXUIElement] ?? []
        return [element] + children.flatMap { accessibilityDescendants($0, depth: depth + 1) }
    }

}
