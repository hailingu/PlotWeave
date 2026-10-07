import AppKit
import SwiftUI
import Testing
@testable import PlotWeaveNative

/// Native title controls share the split view's visibility owner and follow its geometry (matrix N72–N76).
@MainActor
@Suite(.serialized)
struct NativeSidebarToggleTests {
    /// The owner's target is inside the sidebar header, next to its right edge rather than over the canvas (N76).
    @Test func outlineToggleStaysOverSidebar() async throws {
        let window = try makeWindow(layout: ShellLayoutState(), route: "editor", demoMode: true)
        defer { window.close(); window.contentView = nil }
        try await Task.sleep(for: .milliseconds(400))
        try expectControlOverSidebar(window)
        window.setContentSize(NSSize(width: 1300, height: 800))
        let split = try #require(window.contentView.flatMap { firstSplit(in: $0) })
        split.setPosition(320, ofDividerAt: 0)
        try await Task.sleep(for: .milliseconds(400))
        #expect(try #require(split.arrangedSubviews.first).frame.width > 240)
        try expectControlOverSidebar(window)
        try NativeSidebarControlFixture.press(in: window)
        try await Task.sleep(for: .milliseconds(400))
        try NativeSidebarControlFixture.press(in: window)
        try await Task.sleep(for: .milliseconds(400))
        try expectControlOverSidebar(window)
    }

    /// Both appearances expose one reversible native control and follow external layout changes.
    @Test(arguments: [NSAppearance.Name.aqua, .darkAqua])
    func outlineControlTracksSidebarVisibility(appearance: NSAppearance.Name) async throws {
        let layout = ShellLayoutState()
        let window = try makeWindow(layout: layout, route: "editor", demoMode: true)
        window.appearance = NSAppearance(named: appearance)
        defer { window.close(); window.contentView = nil }
        try await Task.sleep(for: .milliseconds(400))
        let control = try NativeSidebarControlFixture.control(in: window)
        #expect(NativeSidebarControlFixture.controls(in: window).count == 1)
        #expect(control.image != nil && control.title.isEmpty)
        #expect(control.toolTip == "隐藏故事大纲")
        try NativeSidebarControlFixture.press(in: window)
        try await Task.sleep(for: .milliseconds(400))
        #expect(!layout.sidebarVisible)
        #expect(control.toolTip == "显示故事大纲")
        try NativeSidebarControlFixture.press(in: window)
        try await Task.sleep(for: .milliseconds(400))
        #expect(layout.sidebarVisible)
        layout.sidebarVisible = false
        try await Task.sleep(for: .milliseconds(400))
        #expect(control.toolTip == "显示故事大纲")
    }

    /// Unavailable project panels expose neither the replacement nor the old automatic toggle.
    @Test(arguments: ["loading", "home", "settings", "editor"])
    func unavailablePanelsHaveNoSidebarControl(route: String) async throws {
        let layout = ShellLayoutState()
        let window = try makeWindow(layout: layout, route: route, demoMode: false)
        defer { window.close(); window.contentView = nil }
        try await Task.sleep(for: .milliseconds(400))
        #expect(NativeSidebarControlFixture.controls(in: window).isEmpty)
        #expect(!items(window).contains { $0.itemIdentifier == .toggleSidebar })
        #expect(layout.sidebarVisible)
    }

    /// Read-only state and the isolated demo page avoid production storage and model services.
    private func makeWindow(layout: ShellLayoutState, route: String, demoMode: Bool) throws -> NSWindow {
        let state = NativeApplicationState()
        state.beginSession("sidebar-control")
        if route != "loading" {
            try state.receiveProjection([
                "protocolVersion": 1, "sessionId": "sidebar-control", "sequence": 1,
                "projection": ["app": ["route": route, "loading": false]]
            ])
        }
        // SwiftUI's unified Window uses full-size content; the fixture must use the same safe-area contract.
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.toolbarStyle = .unified
        window.contentView = NSHostingView(rootView: NativeShellRoot(
            layout: layout, demoMode: demoMode,
            services: NativeHostServices(dataRoot: nil, quit: HostQuitController()), application: state
        ))
        window.orderFront(nil)
        return window
    }

    /// Public toolbar groups enumerate the actual controls without SwiftUI implementation assumptions.
    private func items(_ window: NSWindow) -> [NSToolbarItem] {
        /// Includes supported group members when the system combines neighboring toolbar controls.
        func flattened(_ items: [NSToolbarItem]) -> [NSToolbarItem] {
            items.flatMap { [$0] + (($0 as? NSToolbarItemGroup).map { flattened($0.subitems) } ?? []) }
        }
        return flattened(window.toolbar?.items ?? [])
    }

    /// Public split view geometry identifies the actual leading column without assuming private SwiftUI classes.
    private func firstSplit(in view: NSView) -> NSSplitView? {
        for child in view.subviews { if let split = firstSplit(in: child) { return split } }
        if let split = view as? NSSplitView, split.isVertical, split.subviews.count >= 2 { return split }
        return nil
    }

    /// Real navigation columns use arrangedSubviews; decoration subviews are not sidebar geometry.
    private func expectControlOverSidebar(_ window: NSWindow) throws {
        let split = try #require(window.contentView.flatMap { firstSplit(in: $0) })
        let sidebar = try #require(split.arrangedSubviews.first)
        let control = try NativeSidebarControlFixture.control(in: window)
        let sidebarBounds = sidebar.convert(sidebar.bounds, to: nil)
        let controlBounds = control.convert(control.bounds, to: nil)
        #expect(controlBounds.maxX <= sidebarBounds.maxX)
        #expect(sidebarBounds.maxX - controlBounds.maxX < 40)
        #expect(controlBounds.minX > 80)
        let close = try #require(window.standardWindowButton(.closeButton))
        let closeBounds = close.convert(close.bounds, to: nil)
        #expect(abs(closeBounds.midY - controlBounds.midY) < 4)
    }

}

/// Activates the production outline toggle through public AppKit titlebar and button semantics.
@MainActor
enum NativeSidebarControlFixture {
    /// Activates the actual AppKit button rather than mutating its preference owner directly.
    static func press(in window: NSWindow) throws { try control(in: window).performClick(nil) }

    /// The supported titlebar API confines discovery to this fixture's controls.
    static func control(in window: NSWindow) throws -> NSButton { try #require(controls(in: window).first) }

    /// The accessible outline label identifies its native button independently of private hosting classes.
    static func controls(in window: NSWindow) -> [NSButton] {
        /// Recursion includes publicly hosted controls while excluding unrelated titlebar accessories.
        func buttons(in view: NSView) -> [NSButton] {
            let own = (view as? NSButton).map { $0.accessibilityLabel() == "故事大纲" && !$0.isHidden ? [$0] : [] } ?? []
            return own + view.subviews.flatMap { buttons(in: $0) }
        }
        return window.titlebarAccessoryViewControllers.flatMap { buttons(in: $0.view) }
    }
}
