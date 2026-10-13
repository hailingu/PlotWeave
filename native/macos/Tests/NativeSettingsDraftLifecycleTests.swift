import AppKit
import SwiftUI
import Testing
@testable import PlotWeaveNative

/// A real grouped Form retains synthetic credentials across scrolling and row reconstruction, then clears at lifecycle boundaries.
@MainActor
@Suite(.serialized)
struct NativeSettingsDraftLifecycleTests {
    /// Scrolling a provider away and back must not discard its unsubmitted key or disable Save.
    @Test func scrollingProvidersRetainsKeyUntilSubmissionOrPageDismissal() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let field = try await fixture.firstKeyField()
        fixture.enterSyntheticKey(in: field)
        let initialSave = try await NativeCreationControlFixture.button(in: fixture.window, named: "保存")
        try #require(try NativeCreationControlFixture.isEnabled(initialSave), "合成输入须先更新真实 SecureField 绑定")
        let scroll = try #require(field.enclosingScrollView)
        let document = try #require(scroll.documentView)
        let originalOrigin = scroll.contentView.bounds.origin
        let extent = max(0, document.bounds.height - scroll.contentView.bounds.height)
        document.scroll(NSPoint(x: originalOrigin.x, y: originalOrigin.y < extent / 2 ? extent : 0))
        scroll.reflectScrolledClipView(scroll.contentView)
        try await fixture.wait { field.window == nil || !field.convert(field.bounds, to: document).intersects(document.visibleRect) }
        _ = try await NativeCreationControlFixture.elements(in: fixture.window)
        document.scroll(originalOrigin)
        scroll.reflectScrolledClipView(scroll.contentView)
        let returned = try await fixture.firstKeyField()
        #expect(!returned.stringValue.isEmpty, "滚动返回应保留尚未提交的合成密钥")
        try fixture.setPhase("loading")
        try await fixture.wait { !fixture.hasKeyField }
        try fixture.setPhase("ready")
        let restored = try await fixture.firstKeyField()
        #expect(!restored.stringValue.isEmpty, "设置页仍打开，供应商区域重建不得消费未提交密钥")
        let save = try await NativeCreationControlFixture.button(in: fixture.window, named: "保存")
        #expect(try NativeCreationControlFixture.isEnabled(save))
        try NativeCreationControlFixture.press(save)
        try await fixture.wait { restored.stringValue.isEmpty && fixture.state.error != nil }
        fixture.enterSyntheticKey(in: restored)
        try fixture.setPhase("ready", withoutFirstProvider: true)
        try await fixture.wait { restored.window == nil }
        try fixture.setPhase("ready")
        let readded = try await fixture.firstKeyField()
        #expect(readded.stringValue.isEmpty, "已删除供应商的草稿不能在相同 ID 重现时回显")
        fixture.enterSyntheticKey(in: readded)
        fixture.window.contentView = nil
        fixture.mount()
        let reopened = try await fixture.firstKeyField()
        #expect(reopened.stringValue.isEmpty)
    }

    /// The owned page uses only synthetic read projections and cannot dispatch to a service or user data root.
    @MainActor private final class Fixture {
        /// Synthetic projection owner has no coordinator or service connection.
        let state = NativeApplicationState()
        /// Only this disposable window can expose secure fields to the test.
        let window: NSWindow
        /// Every phase publishes the same synthetic provider identities, without credentials.
        private let providers: [HostJSON]
        /// Ordered read projections use the production session validation.
        private var sequence = 1
        /// Form removal is observed in the actual view tree rather than inferred from phase text.
        var hasKeyField: Bool { descendants(window.contentView).contains { $0 is NSSecureTextField } }

        /// Enough providers require scrolling inside an ordinary settings-sized window.
        init() throws {
            providers = (0..<24).map { index in HostJSON.object([
                "id": .string("fixture-\(index)"), "label": .string("合成服务 \(index)"),
                "baseUrl": .string("https://example.test/v1"), "enabled": .bool(true),
                "models": .array([.string("fixture-model")]), "keyConfigured": .bool(false)
            ]) }
            state.beginSession("settings-drafts")
            try state.receiveProjection([
                "protocolVersion": 1, "sessionId": "settings-drafts", "sequence": 1,
                "projection": HostJSON.object([
                    "app": .object(["route": .string("settings")]),
                    "settings": .object(["phase": .string("ready"), "providers": .array(providers)])
                ]).webValue
            ])
            window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 580),
                              styleMask: [.titled], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.level = .floating
            mount()
            window.orderFrontRegardless()
        }

        /// Reattaching a new settings root establishes a new page-scoped draft lifetime.
        func mount() {
            window.contentView = NSHostingView(rootView: NativeSettingsView(state: state))
            window.contentView?.layoutSubtreeIfNeeded()
        }

        /// Existing loading and provider-removal projections replace rows while retaining the same settings page.
        func setPhase(_ phase: String, withoutFirstProvider: Bool = false) throws {
            sequence += 1
            try state.receiveProjection([
                "protocolVersion": 1, "sessionId": "settings-drafts", "sequence": sequence,
                "projection": HostJSON.object([
                    "app": .object(["route": .string("settings")]),
                    "settings": .object(["phase": .string(phase), "providers": .array(withoutFirstProvider ? Array(providers.dropFirst()) : providers)])
                ]).webValue
            ])
        }

        /// Real NSTextField delegate delivery updates SwiftUI's SecureField binding with a known synthetic value.
        func enterSyntheticKey(in field: NSSecureTextField) {
            field.stringValue = "fixture-only-key"
            field.delegate?.controlTextDidChange?(Notification(name: NSControl.textDidChangeNotification, object: field))
        }

        /// Bounded polling resolves only the first provider's currently visible native secure control.
        func firstKeyField() async throws -> NSSecureTextField {
            var result: NSSecureTextField?
            try await wait {
                result = self.descendants(self.window.contentView).compactMap { $0 as? NSSecureTextField }.first {
                    $0.window != nil && !$0.isHiddenOrHasHiddenAncestor && !$0.visibleRect.isEmpty
                }
                return result != nil
            }
            return try #require(result)
        }

        /// All asynchronous expectations fail within the existing native fixture deadline.
        func wait(_ predicate: () -> Bool) async throws {
            let deadline = ContinuousClock.now.advanced(by: .seconds(5))
            while !predicate() && ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(30)) }
            try #require(predicate())
        }

        /// Traversal stays within this test's own AppKit content tree.
        private func descendants(_ view: NSView?) -> [NSView] {
            guard let view else { return [] }
            return [view] + view.subviews.flatMap { descendants($0) }
        }

        /// Disposes only the synthetic page, without touching any service or application data.
        func remove() { window.close(); window.contentView = nil }
    }
}
