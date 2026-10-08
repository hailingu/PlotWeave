import AppKit
import ApplicationServices
import Testing

/// Reads and activates the real SwiftUI button through the public macOS accessibility client API.
@MainActor
enum NativeCreationControlFixture {
    /// A unique title selects only the disposable fixture window, excluding the hosted application's main window.
    static func button(in window: NSWindow, named name: String = "新建短剧") async throws -> AXUIElement {
        try await element(in: window, named: name, roles: [kAXButtonRole])
    }

    /// Named native inputs and buttons share one public accessibility lookup within the owned window.
    static func element(in window: NSWindow, named name: String, roles: [String]) async throws -> AXUIElement {
        try #require(await elements(in: window).first {
            roles.contains(string($0, kAXRoleAttribute) ?? "")
                && (string($0, kAXTitleAttribute) == name || string($0, kAXDescriptionAttribute) == name)
        })
    }

    /// Traversal is restricted to the uniquely titled fixture so unrelated application windows cannot match.
    static func elements(in window: NSWindow) async throws -> [AXUIElement] {
        window.title = "创建控件回归-" + UUID().uuidString
        let application = AXUIElementCreateApplication(getpid())
        _ = attribute(application, kAXWindowsAttribute)
        try await Task.sleep(for: .milliseconds(100))
        let windows = attribute(application, kAXWindowsAttribute) as? [AXUIElement] ?? []
        let owned = try #require(windows.first { string($0, kAXTitleAttribute) == window.title })
        return descendants(owned)
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

    /// Screen-space geometry allows independently rendered controls to be compared after native layout.
    static func frame(_ element: AXUIElement) throws -> CGRect {
        let value = try #require(attribute(element, kAXPositionAttribute))
        try #require(CFGetTypeID(value) == AXValueGetTypeID())
        let geometry = unsafeDowncast(value, to: AXValue.self)
        var position = CGPoint.zero
        try #require(AXValueGetValue(geometry, .cgPoint, &position))
        return CGRect(origin: position, size: try size(element))
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
