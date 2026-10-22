import AppKit
import ApplicationServices
import SwiftUI
import Testing
@testable import PlotWeaveNative

/// Exercises the production homepage controls at their AppKit rendering boundary.
@MainActor
@Suite(.serialized)
struct NativeHomeViewTests {
    /// Canonical millisecond metadata must render the same relative-time field as legacy whole seconds.
    @Test(arguments: ["2026-10-12T03:05:04.123Z", "2026-10-12T03:05:04Z", "invalid"])
    func projectTimestampRendersRelativeTime(timestamp: String) async throws {
        let state = NativeApplicationState()
        let window = try makeWindow(state: state, projects: [["id": "dated", "name": "时间回归"]])
        defer { window.close(); window.contentView = nil }
        try await Task.sleep(for: .milliseconds(300))
        let original = try await staticTextValues(in: window)
        try state.receiveProjection([
            "protocolVersion": 1, "sessionId": "home-controls", "sequence": 2,
            "projection": ["app": ["route": "home", "loading": false,
                "projects": [["id": "dated", "name": "时间回归", "updatedAt": timestamp]]]]
        ])
        try await Task.sleep(for: .milliseconds(300))
        let updated = try await staticTextValues(in: window)
        let metadata = updated.subtracting(original)
        #expect(metadata.count == (timestamp == "invalid" ? 0 : 1), "Rendered metadata: \(metadata)")
    }

    /// Relative-date wording is locale-owned; the fixture compares actual accessible fields instead of prose.
    private func staticTextValues(in window: NSWindow) async throws -> Set<String> {
        let elements = try await NativeCreationControlFixture.elements(in: window)
        let texts = elements.filter { NativeCreationControlFixture.string($0, kAXRoleAttribute) == kAXStaticTextRole }
        return Set(texts.compactMap { NativeCreationControlFixture.string($0, kAXValueAttribute) }.filter { !$0.isEmpty })
    }

    /// Every direct welcome-control fixture uses the owner's fixed Xcode point geometry, including both appearances.
    @Test func welcomeControlsUseOnlyReferenceGeometry() throws {
        let window = try makeWindow()
        defer { window.close(); window.contentView = nil }
        // Owner reference N66/N71: 960 × 1264 screenshot pixels are 480 × 632 layout points.
        #expect(window.frame.size == NSSize(width: 480, height: 632))
        #expect(!window.styleMask.contains(.resizable))
        #expect(window.titleVisibility == .hidden && window.titlebarAppearsTransparent)
        for kind in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
            #expect(window.standardWindowButton(kind)?.isHidden != false)
        }
    }

    /// The custom close control must use this fixture's normal window delegate and honor its refusal.
    @Test func customCloseHonorsWindowDelegate() async throws {
        let window = try makeWindow()
        let delegate = RefusingCloseDelegate()
        window.delegate = delegate
        defer { window.delegate = nil; window.close(); window.contentView = nil }
        try await Task.sleep(for: .milliseconds(300))
        let button = try await NativeCreationControlFixture.button(in: window, named: "关闭欢迎页")
        let size = try NativeCreationControlFixture.size(button)
        // Owner reference N66: the 75 px circular close control is 37.5 pt at 2×.
        #expect(abs(size.width - 37.5) <= 0.5 && abs(size.height - 37.5) <= 0.5)
        try NativeCreationControlFixture.press(button)
        #expect(delegate.requests == 1)
        #expect(window.isVisible)
    }

    /// An empty loaded library cannot invent a selection or enable the Open action.
    @Test func emptyLibraryDisablesOpening() async throws {
        let window = try makeWindow(projects: [])
        defer { window.close(); window.contentView = nil }
        try await Task.sleep(for: .milliseconds(300))
        let button = try await NativeCreationControlFixture.button(in: window, named: "打开项目")
        #expect(try !NativeCreationControlFixture.isEnabled(button))
        #expect(descendants(window.contentView).compactMap { $0 as? NSTableView }.isEmpty)
        let creation = try await NativeCreationControlFixture.button(in: window)
        #expect(try NativeCreationControlFixture.isEnabled(creation))
    }

    /// Opening is explicit; the welcome list selects a project without navigating on a single click.
    @Test func welcomeListSelectsWithoutOpening() async throws {
        let state = NativeApplicationState()
        let window = try makeWindow(state: state)
        defer { window.close(); window.contentView = nil }
        try await Task.sleep(for: .milliseconds(300))
        let button = try await NativeCreationControlFixture.button(in: window, named: "打开项目")
        let table = try #require(descendants(window.contentView).compactMap { $0 as? NSTableView }.first)
        #expect(table.selectedRow == 0)
        table.selectRowIndexes(IndexSet(integer: 1), byExtendingSelection: false)
        try await Task.sleep(for: .milliseconds(100))
        #expect(table.selectedRow == 1)
        #expect(state.route == "home" && !state.busy && state.error == nil)
        #expect(try NativeCreationControlFixture.isEnabled(button))
    }

    /// Reordering preserves identity; removing it must not redirect a later Open action to another project.
    @Test func removedSelectionDisablesOpening() async throws {
        let state = NativeApplicationState()
        let window = try makeWindow(state: state)
        defer { window.close(); window.contentView = nil }
        try await Task.sleep(for: .milliseconds(300))
        let button = try await NativeCreationControlFixture.button(in: window, named: "打开项目")
        let table = try #require(descendants(window.contentView).compactMap { $0 as? NSTableView }.first)
        table.selectRowIndexes(IndexSet(integer: 1), byExtendingSelection: false)
        try await Task.sleep(for: .milliseconds(100))
        try state.receiveProjection([
            "protocolVersion": 1, "sessionId": "home-controls", "sequence": 2,
            "projection": ["app": ["route": "home", "loading": false,
                "projects": [["id": "second", "name": "午夜出租车"], ["id": "first", "name": "都市奇缘"]]]]
        ])
        try await Task.sleep(for: .milliseconds(300))
        #expect(table.selectedRow == 0)
        #expect(try NativeCreationControlFixture.isEnabled(button))
        try state.receiveProjection([
            "protocolVersion": 1, "sessionId": "home-controls", "sequence": 3,
            "projection": ["app": ["route": "home", "loading": false,
                "projects": [["id": "first", "name": "都市奇缘"]]]]
        ])
        try await Task.sleep(for: .milliseconds(300))
        #expect(try !NativeCreationControlFixture.isEnabled(button))
        #expect(table.selectedRow == -1)
        #expect(state.error == nil)
    }

    /// Opening must wait for a finished list just like the existing creation command.
    @Test func loadingDisablesOpening() async throws {
        let window = try makeWindow(loading: true)
        defer { window.close(); window.contentView = nil }
        try await Task.sleep(for: .milliseconds(300))
        let button = try await NativeCreationControlFixture.button(in: window, named: "打开项目")
        #expect(try !NativeCreationControlFixture.isEnabled(button))
    }

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

    /// Rounded welcome actions retain readable help and platform target sizes in either system appearance.
    @Test(arguments: [NSAppearance.Name.aqua, .darkAqua])
    func creationHasAccessiblePrimaryPresentation(appearance: NSAppearance.Name) async throws {
        let window = try makeWindow()
        defer { window.close(); window.contentView = nil }
        window.appearance = NSAppearance(named: appearance)
        try await Task.sleep(for: .milliseconds(300))
        #expect(window.frame.size == NSSize(width: 480, height: 632))
        for name in ["打开项目", "新建短剧"] {
            let button = try await NativeCreationControlFixture.button(in: window, named: name)
            let size = try NativeCreationControlFixture.size(button)
            // Owner reference N69: 215 × 75 pixels at 2×, with a half-point rendering tolerance.
            #expect(abs(size.width - 107.5) <= 0.5 && abs(size.height - 37.5) <= 0.5)
            #expect(NativeCreationControlFixture.string(button, kAXHelpAttribute) != nil)
            #expect(try NativeCreationControlFixture.isEnabled(button))
            if name == "新建短剧" {
                #expect(NativeCreationControlFixture.string(button, kAXHelpAttribute) == "新建短剧（⌘N）")
            }
        }
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

    /// The native error banner exposes only recovery that the authoritative Web owner explicitly permits.
    @Test(arguments: [true, false])
    func recoveryControlMatchesFailureEligibility(canRetry: Bool) async throws {
        let state = NativeApplicationState()
        let window = try makeWindow(state: state)
        defer { window.close(); window.contentView = nil }
        try state.receiveProjection([
            "protocolVersion": 1, "sessionId": "home-controls", "sequence": 2,
            "projection": ["app": ["route": "home", "loading": false, "projects": [],
                "error": "隔离复制失败", "recovery": ["id": "1", "action": "duplicate", "canRetry": canRetry]]]
        ])
        try await Task.sleep(for: .milliseconds(300))
        let elements = try await NativeCreationControlFixture.elements(in: window)
        let buttons = elements.filter { NativeCreationControlFixture.string($0, kAXRoleAttribute) == kAXButtonRole }
        let names = buttons.flatMap { [NativeCreationControlFixture.string($0, kAXTitleAttribute),
                                      NativeCreationControlFixture.string($0, kAXDescriptionAttribute)].compactMap { $0 } }
        #expect(names.contains("重试复制") == canRetry)
        #expect(!names.contains("刷新列表"))
    }

    /// Read-only controls use only the fixed welcome geometry, with no editor-sized or real-data fixture.
    private func makeWindow(
        loading: Bool = false, state: NativeApplicationState = NativeApplicationState(),
        projects: [[String: String]] = [["id": "first", "name": "都市奇缘"], ["id": "second", "name": "午夜出租车"]]
    ) throws -> NSWindow {
        state.beginSession("home-controls")
        try state.receiveProjection([
            "protocolVersion": 1, "sessionId": "home-controls", "sequence": 1,
            "projection": ["app": ["route": "home", "loading": loading, "projects": projects]]
        ])
        let frame = NSRect(origin: .zero, size: NativeWelcomeMetrics.windowSize)
        let window = NSWindow(contentRect: frame,
                              styleMask: [.titled, .closable, .fullSizeContentView], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        for kind in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
            window.standardWindowButton(kind)?.isHidden = true
        }
        let content = NSHostingView(rootView: NativeHomeView(state: state).ignoresSafeArea())
        content.sizingOptions = []
        window.contentView = content
        window.setFrame(frame, display: false)
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

/// A refused normal close proves the custom control cannot bypass AppKit's delegate boundary.
@MainActor
private final class RefusingCloseDelegate: NSObject, NSWindowDelegate {
    /// Requests count actual delegate invocations rather than a mocked view action.
    private(set) var requests = 0

    /// Keeps the fixture visible just as a pending or failed save barrier does.
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        requests += 1
        return false
    }
}
