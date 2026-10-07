import AppKit
import SwiftUI
import Testing
@testable import PlotWeaveNative

/// Real toolbar and menu controls enforce the project-library navigation contract.
@MainActor
@Suite(.serialized)
struct NativeProjectLibraryNavigationTests {
    /// Home, settings and loading must not offer an unavailable return-to-library toolbar action.
    @Test(arguments: ["home", "settings", "loading"])
    func libraryToolbarIsAbsentOutsideEditor(route: String) async throws {
        let window = try makeWindow(route: route)
        defer { window.close(); window.contentView = nil }
        try await Task.sleep(for: .milliseconds(300))
        let toolbar = try #require(window.toolbar)
        let labels = flattened(toolbar.items).map(\.label)
        #expect(!labels.contains("首页"))
        #expect(!labels.contains("返回项目片库"))
    }

    /// The editor's system button identifies its actual destination and provides matching hover help.
    @Test func editorReturnButtonNamesItsDestination() async throws {
        let window = try makeWindow(route: "editor")
        defer { window.close(); window.contentView = nil }
        try await Task.sleep(for: .milliseconds(300))
        let toolbar = try #require(window.toolbar)
        let item = try #require(flattened(toolbar.items).first { $0.label == "返回项目片库" })
        #expect(item.toolTip == "返回项目片库")
    }

    /// The real app menu exposes the toolbar command while hosted tests keep its app owner unavailable.
    @Test func menuBarExposesProjectLibraryReturn() throws {
        let menu = try #require(NSApp.mainMenu)
        let item = try #require(menuItems(menu).first { $0.title == "返回项目片库" })
        menu.update()
        item.menu?.update()
        #expect(!item.isEnabled)
    }

    /// A missing page reports a failure without pretending to return or leaving navigation permanently busy.
    @Test func unavailablePageKeepsEditorAndClearsBusyState() async throws {
        let state = NativeApplicationState()
        let window = try makeWindow(route: "editor", state: state)
        defer { window.close(); window.contentView = nil }
        try await Task.sleep(for: .milliseconds(300))
        try ProjectLibraryToolbarFixture.activateReturn(in: window)
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while state.error == nil && ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
        #expect(state.error != nil)
        #expect(state.route == "editor")
        #expect(!state.busy)
    }

    /// Mounts the production toolbar with read-only projections and no WebKit or storage services.
    private func makeWindow(route: String, state: NativeApplicationState = NativeApplicationState()) throws -> NSWindow {
        state.beginSession("library-navigation")
        if route != "loading" {
            try state.receiveProjection([
                "protocolVersion": 1, "sessionId": "library-navigation", "sequence": 1,
                "projection": ["app": ["route": route, "loading": false,
                    "project": route == "editor" ? ["id": "project", "name": "测试短剧"] : [:]]]
            ])
        }
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1100, height: 750),
            styleMask: [.titled], backing: .buffered, defer: false
        )
        window.isReleasedWhenClosed = false
        let root = NavigationSplitView {
            Text("故事大纲")
        } detail: {
            Text("项目画布")
        }
        .toolbar { NativeEditorToolbar(state: state, layout: ShellLayoutState()) }
        window.contentView = NSHostingView(rootView: root)
        window.contentView?.layoutSubtreeIfNeeded()
        window.orderFrontRegardless()
        return window
    }

    /// Public toolbar groups expose their member controls without private SwiftUI hierarchy assumptions.
    private func flattened(_ items: [NSToolbarItem]) -> [NSToolbarItem] {
        items.flatMap { item in
            [item] + ((item as? NSToolbarItemGroup).map { flattened($0.subitems) } ?? [])
        }
    }

    /// Searches actual menu semantics rather than source strings or command-builder implementation details.
    private func menuItems(_ menu: NSMenu) -> [NSMenuItem] {
        menu.items.flatMap { [$0] + ($0.submenu.map(menuItems) ?? []) }
    }
}

/// Sends pointer events to the production toolbar surface without assuming a SwiftUI button's private type.
@MainActor
enum ProjectLibraryToolbarFixture {
    /// The actual hosted control receives down/up events at its center and owns navigation dispatch.
    static func activateReturn(in window: NSWindow) throws {
        let toolbar = try #require(window.toolbar)
        let item = try #require(toolbar.items.first { $0.label == "返回项目片库" })
        let view = try #require(item.view)
        let point = view.convert(NSPoint(x: view.bounds.midX, y: view.bounds.midY), to: nil)
        let down = try #require(NSEvent.mouseEvent(
            with: .leftMouseDown, location: point, modifierFlags: [],
            timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
            context: nil, eventNumber: 1, clickCount: 1, pressure: 1
        ))
        let up = try #require(NSEvent.mouseEvent(
            with: .leftMouseUp, location: point, modifierFlags: [],
            timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
            context: nil, eventNumber: 2, clickCount: 1, pressure: 0
        ))
        NSApp.postEvent(up, atStart: true)
        window.sendEvent(down)
    }
}
