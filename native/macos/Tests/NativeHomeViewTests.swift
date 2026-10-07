import AppKit
import ApplicationServices
import SwiftUI
import Testing
@testable import PlotWeaveNative

/// Exercises the production homepage controls at their AppKit rendering boundary.
@MainActor
@Suite(.serialized)
struct NativeHomeViewTests {
    /// Reintroducing a homepage search field violates the owner's unfiltered-library UI contract.
    @Test func projectLibraryHasNoSearchField() async throws {
        let window = try makeWindow()
        defer { window.close(); window.contentView = nil }
        try await Task.sleep(for: .milliseconds(300))
        let fields = descendants(window.contentView).compactMap { $0 as? NSTextField }
        #expect(fields.filter(\.isEditable).isEmpty)
        #expect(descendants(window.contentView).compactMap { $0 as? NSPopUpButton }.count == 2)
    }

    /// The system menu must retain its actions while drawing only the existing ellipsis label.
    @Test func projectMenusHideSystemArrows() async throws {
        let window = try makeWindow()
        defer { window.close(); window.contentView = nil }
        try await Task.sleep(for: .milliseconds(300))
        let menus = descendants(window.contentView).compactMap { $0 as? NSPopUpButton }
        #expect(menus.count == 2)
        for menu in menus {
            let cell = try #require(menu.cell as? NSPopUpButtonCell)
            #expect(cell.arrowPosition == .noArrow)
            #expect(menu.isEnabled)
        }
    }

    /// Removing primary presentation or help leaves the creation action less discoverable in either system appearance.
    @Test(arguments: [NSAppearance.Name.aqua, .darkAqua])
    func creationHasAccessiblePrimaryPresentation(appearance: NSAppearance.Name) async throws {
        let window = try makeWindow()
        defer { window.close(); window.contentView = nil }
        window.appearance = NSAppearance(named: appearance)
        try await Task.sleep(for: .milliseconds(300))
        let button = try await NativeCreationControlFixture.button(in: window)
        let size = try NativeCreationControlFixture.size(button)
        // Apple HIG Accessibility's macOS default control size is 28 × 28 pt.
        #expect(size.width >= 28 && size.height >= 28)
        #expect(NativeCreationControlFixture.string(button, kAXHelpAttribute) == "新建短剧（⌘N）")
        #expect(try NativeCreationControlFixture.isEnabled(button))
    }

    /// Changing only the header must not make project creation available before the list is ready.
    @Test func loadingDisablesCreationControl() async throws {
        let window = try makeWindow(loading: true)
        defer { window.close(); window.contentView = nil }
        try await Task.sleep(for: .milliseconds(300))
        let button = try await NativeCreationControlFixture.button(in: window)
        #expect(try !NativeCreationControlFixture.isEnabled(button))
    }

    /// A mismatched menu label hides the equivalence between keyboard and visible creation entry points.
    @Test func creationMenuMatchesButtonAndRetainsCommandN() throws {
        let menu = try #require(NSApp.mainMenu)
        let item = try #require(menuItems(menu).first { $0.title == "新建短剧" })
        #expect(item.keyEquivalent == "n")
        #expect(item.keyEquivalentModifierMask == .command)
    }

    /// Read-only projections seed real SwiftUI controls without opening any user data directory.
    private func makeWindow(loading: Bool = false) throws -> NSWindow {
        let state = NativeApplicationState()
        state.beginSession("home-controls")
        try state.receiveProjection([
            "protocolVersion": 1, "sessionId": "home-controls", "sequence": 1,
            "projection": ["app": ["route": "home", "loading": loading, "projects": [
                ["id": "first", "name": "都市奇缘"],
                ["id": "second", "name": "午夜出租车"]
            ]]]
        ])
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1000, height: 700),
            styleMask: [.titled], backing: .buffered, defer: false
        )
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: NativeHomeView(state: state))
        window.contentView?.layoutSubtreeIfNeeded()
        window.orderFrontRegardless()
        return window
    }

    /// Uses public AppKit control types rather than private SwiftUI implementation names.
    private func descendants(_ view: NSView?) -> [NSView] {
        guard let view else { return [] }
        return [view] + view.subviews.flatMap { descendants($0) }
    }

    /// Actual menu items expose command names and key equivalents through supported AppKit semantics.
    private func menuItems(_ menu: NSMenu) -> [NSMenuItem] {
        menu.items.flatMap { [$0] + ($0.submenu.map(menuItems) ?? []) }
    }

}
