import AppKit
import ApplicationServices
import SwiftUI
import Testing
@testable import PlotWeaveNative

/// The export sheet's defaults must not fork from the Web dialog: the outline appendix is
/// opt-in in both shells (docs/ui-design.md §5, issue #598).
@MainActor
@Suite(.serialized)
struct NativeExportSheetDefaultsTests {
    /// The sheet opens on Markdown with the outline checkbox off, and the control stays reversible.
    @Test func markdownOutlineToggleDefaultsOffLikeWebDialog() async throws {
        let window = try makeWindow()
        defer { window.close(); window.contentView = nil }
        try await Task.sleep(for: .milliseconds(400))
        let toggle = try await NativeCreationControlFixture.element(
            in: window, named: "创作大纲（节奏与分支）", roles: [kAXCheckBoxRole]
        )
        #expect(!isChecked(toggle), "创作大纲开关默认应与 Web 导出对话框一致（默认关闭）")
        try NativeCreationControlFixture.press(toggle)
        try await Task.sleep(for: .milliseconds(200))
        #expect(isChecked(toggle))
    }

    /// The sheet mounts with production state and services; no web session is fabricated for defaults.
    private func makeWindow() throws -> NSWindow {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 620),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: NativeExportView(
            state: NativeApplicationState(),
            services: NativeHostServices(dataRoot: nil, quit: HostQuitController()),
            projectId: "fixture-export-defaults"
        ))
        window.orderFront(nil)
        return window
    }

    /// The public accessibility client API reports checkbox state as a numeric 0/1 value.
    private func isChecked(_ element: AXUIElement) -> Bool {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &value) == .success,
              let number = value as? NSNumber else { return false }
        return number.boolValue
    }
}
