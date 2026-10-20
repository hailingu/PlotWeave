import AppKit
import ApplicationServices
import SwiftUI
import Testing

/// Disposable visible window supports semantic controls and text delivery without private SwiftUI view inspection.
@MainActor
final class NativeCoverageWindow {
    /// This disposable native window is the sole target of every control lookup.
    let window: NSWindow

    /// Fixed owned geometry isolates focus, accessibility lookup and cleanup from the application window.
    init<V: View>(_ view: V, width: CGFloat = 900, height: CGFloat = 700) {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: height), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.level = .floating
        mount(view)
        window.orderFrontRegardless()
    }

    /// Remount is explicit so no view-owned task is retained between independent form scenarios.
    func mount<V: View>(_ view: V) {
        let content = NSHostingView(rootView: view)
        content.sizingOptions = []
        window.contentView = content
    }

    /// Only this window's content is released; the hosted test application's main window is untouched.
    func close() { window.contentView = nil; window.close() }

    /// The public text-field delegate follows the same production binding route as typed edits.
    func enter(_ value: String, replacing previous: String) async throws {
        var field: NSTextField?
        try await Self.wait { field = self.descendants(self.window.contentView).compactMap { $0 as? NSTextField }.first { $0.isEditable && $0.stringValue == previous }; return field != nil }
        let target = try #require(field)
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(target)
        target.stringValue = value
        target.delegate?.controlTextDidChange?(Notification(name: NSControl.textDidChangeNotification, object: target))
    }

    /// Named controls use existing public AX helpers rather than invoking a view's callback directly.
    func press(_ name: String) async throws {
        let button = try await NativeCreationControlFixture.button(in: window, named: name)
        try #require(try NativeCreationControlFixture.isEnabled(button))
        _ = AXUIElementPerformAction(button, kAXPressAction as CFString)
    }

    /// Actual exposed strings verify rendered content and fallback diagnostics without pixel snapshots.
    func strings() async throws -> [String] {
        try await NativeCreationControlFixture.elements(in: window).flatMap { element in
            [kAXValueAttribute, kAXTitleAttribute, kAXDescriptionAttribute].compactMap { NativeCreationControlFixture.string(element, $0) }
        }
    }

    /// Finite condition waits require the control, projection or persistence receipt actually under test.
    static func wait(_ description: String = "Owned native control did not settle", _ predicate: () -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(12))
        while !predicate(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
        try #require(predicate(), "\(description)")
    }

    /// Public AppKit hierarchy traversal is limited to controls within this disposable window.
    private func descendants(_ view: NSView?) -> [NSView] {
        guard let view else { return [] }
        return [view] + view.subviews.flatMap { descendants($0) }
    }
}
