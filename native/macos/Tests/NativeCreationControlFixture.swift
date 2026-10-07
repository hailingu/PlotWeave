import AppKit
import ApplicationServices
import Testing

/// Reads and activates the real SwiftUI button through the public macOS accessibility client API.
@MainActor
enum NativeCreationControlFixture {
    /// A unique title selects only the disposable fixture window, excluding the hosted application's main window.
    static func button(in window: NSWindow) async throws -> AXUIElement {
        window.title = "创建控件回归-" + UUID().uuidString
        let application = AXUIElementCreateApplication(getpid())
        _ = attribute(application, kAXWindowsAttribute)
        try await Task.sleep(for: .milliseconds(100))
        let windows = attribute(application, kAXWindowsAttribute) as? [AXUIElement] ?? []
        let owned = try #require(windows.first { string($0, kAXTitleAttribute) == window.title })
        return try #require(descendants(owned).first {
            string($0, kAXRoleAttribute) == kAXButtonRole
                && (string($0, kAXTitleAttribute) == "新建短剧" || string($0, kAXDescriptionAttribute) == "新建短剧")
        })
    }

    /// Strings retain the system-exposed control semantics rather than inspecting source or private view classes.
    static func string(_ element: AXUIElement, _ name: String) -> String? {
        attribute(element, name) as? String
    }

    /// Enabled state is queried on the actual actionable element, not toolbar metadata.
    static func isEnabled(_ element: AXUIElement) throws -> Bool {
        try #require(attribute(element, kAXEnabledAttribute) as? Bool)
    }

    /// Accessibility geometry reports the actual control bounds in logical points.
    static func size(_ element: AXUIElement) throws -> CGSize {
        let value = try #require(attribute(element, kAXSizeAttribute))
        try #require(CFGetTypeID(value) == AXValueGetTypeID())
        let geometry = unsafeDowncast(value, to: AXValue.self)
        var size = CGSize.zero
        try #require(AXValueGetValue(geometry, .cgSize, &size))
        return size
    }

    /// The supported press action invokes the production control's existing action owner.
    static func press(_ element: AXUIElement) throws {
        try #require(AXUIElementPerformAction(element, kAXPressAction as CFString) == .success)
    }

    /// Attribute errors become absent fixture values and are surfaced by the caller's required semantic assertion.
    private static func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
        return value
    }

    /// A bounded public accessibility traversal contains only descendants of this fixture's window.
    private static func descendants(_ element: AXUIElement, depth: Int = 0) -> [AXUIElement] {
        guard depth < 20 else { return [] }
        let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
        return [element] + children.flatMap { descendants($0, depth: depth + 1) }
    }
}
