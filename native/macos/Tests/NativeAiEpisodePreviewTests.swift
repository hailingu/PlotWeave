import AppKit
import ApplicationServices
import SwiftUI
import Testing
@testable import PlotWeaveNative

/// Real native controls expose episode conflicts until this preview is executed; no model or storage is used.
@MainActor
@Suite(.serialized, WebKitTestIsolation())
struct NativeAiEpisodePreviewTests {
    /// Public accessibility observes arm/confirm labels and the removal of pending warnings after execution.
    @Test func episodeConflictControlsFollowPendingArmedAndExecutedState() async throws {
        let state = NativeApplicationState()
        state.beginSession("episode-preview")
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 640, height: 780),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.level = .floating
        defer { window.close(); window.contentView = nil }
        try publish(state, sequence: 1, status: "pending", armed: false)
        window.contentView = NSHostingView(rootView: NativeAiView(state: state, projectId: "episode-fixture"))
        window.contentView?.layoutSubtreeIfNeeded()
        window.orderFrontRegardless()
        let pending = try await labels(window, containing: "确认分集冲突…")
        #expect(pending.contains("确认分集冲突…"))
        #expect(pending.contains(where: { $0.contains("第 9 集 → 第 1 集") }))
        #expect(!pending.contains("确认本次分集冲突并执行"))

        try publish(state, sequence: 2, status: "pending", armed: true)
        let armed = try await labels(window, containing: "确认本次分集冲突并执行")
        #expect(armed.contains("确认本次分集冲突并执行"))
        #expect(armed.contains("忽略"))

        try publish(state, sequence: 3, status: "executed", armed: false)
        let executed = try await labels(window, containing: "已执行 · 可整批撤销")
        #expect(executed.contains(where: { $0.contains("已执行") }))
        #expect(!executed.contains("忽略"))
        #expect(!executed.contains("确认分集冲突…"))
        #expect(!executed.contains(where: { $0.contains("第 9 集 → 第 1 集") || $0.contains("尚未执行") }))
    }

    /// Synthetic projections use the production session and sequence boundary, without sending any execute intent.
    private func publish(_ state: NativeApplicationState, sequence: Double, status: String, armed: Bool) throws {
        var ai: [String: Any] = [
            "projectId": "episode-fixture", "ready": true, "busy": false,
            "thread": [["id": 2, "kind": "msg", "role": "assistant", "text": "合成分集方案",
                        "card": ["status": status, "v": ["ok": true, "hasDeletes": false, "commands": [], "items": [], "issues": [],
                                                          "episodeAssignment": ["fingerprint": "preview-only", "commandCount": 2,
                                                                                "conflicts": ["天台：第 9 集 → 第 1 集；覆盖须人工确认。"]]]]]]
        ]
        if armed { ai["armedEntryId"] = 2 }
        try state.receiveProjection([
            "protocolVersion": 1, "sessionId": "episode-preview", "sequence": sequence,
            "projection": ["app": ["route": "editor", "project": ["id": "episode-fixture", "name": "合成剧本"]], "ai": ai]
        ])
    }

    /// Reads only the owned fixture window's public accessibility labels and values after SwiftUI commits its update.
    private func labels(_ window: NSWindow, containing expected: String) async throws -> [String] {
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        repeat {
            let elements = try await NativeCreationControlFixture.elements(in: window)
            let labels = elements.flatMap { element in
                [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute].compactMap {
                    NativeCreationControlFixture.string(element, $0)
                }
            }
            if labels.contains(expected) { return labels }
        } while ContinuousClock.now < deadline
        throw HostFailure(code: "PW_TEST_EPISODE_PREVIEW_TIMEOUT", message: "原生分集预览控件未就绪：\(expected)")
    }
}
