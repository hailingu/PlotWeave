import AppKit
import Testing

/// Dispatches mouse events only to a test-owned window; no external application or global input is automated.
@MainActor
enum NativeMouseEventFixture {
    /// AX uses top-left screen coordinates; AppKit uses bottom-left screen and window coordinates.
    static func click(in window: NSWindow, accessibilityPoint point: CGPoint) throws {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        let screen = try #require(NSScreen.screens.first)
        let location = window.convertPoint(fromScreen: CGPoint(x: point.x, y: screen.frame.maxY - point.y))
        let down = try #require(NSEvent.mouseEvent(with: .leftMouseDown, location: location, modifierFlags: [],
            timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
            context: nil, eventNumber: 1, clickCount: 1, pressure: 1))
        let up = try #require(NSEvent.mouseEvent(with: .leftMouseUp, location: location, modifierFlags: [],
            timestamp: down.timestamp + 0.05, windowNumber: window.windowNumber,
            context: nil, eventNumber: 2, clickCount: 1, pressure: 0))
        try #require(down.window === window && up.window === window)
        print("[owned-mouse] key=\(window.isKeyWindow) active=\(NSApp.isActive) point=\(location) content=\(window.contentLayoutRect)")
        // SwiftUI button tracking can synchronously wait for mouse-up; enqueue the complete click first.
        NSApp.postEvent(down, atStart: false)
        NSApp.postEvent(up, atStart: false)
        while let next = NSApp.nextEvent(matching: .any, until: nil, inMode: .default, dequeue: true) {
            if next === down || next === up { window.sendEvent(next) }
            else { NSApp.sendEvent(next) }
        }
    }
}
