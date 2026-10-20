import AppKit
import SwiftUI
import Testing
@testable import PlotWeaveNative

/// Real toolbar geometry guards the owner's two-ended inspector arrangement (N84).
@MainActor
@Suite(.serialized)
struct NativeInspectorToolbarTests {
    /// Creation stays inside the inspector's leading edge while project tools follow its trailing edge.
    @Test func inspectorToolsUseAvailableColumnWidth() async throws {
        let layout = ShellLayoutState()
        let window = try makeWindow(layout: layout)
        defer { window.close(); window.contentView = nil }
        let split = try await waitForInspector(in: window)
        try expectTwoEnds(in: window)
        split.setPosition(window.contentLayoutRect.width - 300, ofDividerAt: 0)
        try await waitForTwoEnds(in: window, expectedWidth: 300)
        try expectTwoEnds(in: window)
        layout.toggleInspector()
        try await NativeLayoutFixture.waitForInspector(in: window, visible: false)
        #expect(try frame(of: "添加节点", in: window).width > 0)
        #expect(try frame(of: "检查器", in: window).width > 0)
        layout.toggleInspector()
        _ = try await waitForInspector(in: window, expectedWidth: 300)
        try expectTwoEnds(in: window)
        window.setContentSize(NSSize(width: 1400, height: 800))
        split.setPosition(900, ofDividerAt: 0)
        try await waitForTwoEnds(in: window, expectedWidth: 500)
        try expectTwoEnds(in: window)
    }

    /// A read-only projection isolates native toolbar presentation from Web sessions and user storage.
    private func makeWindow(layout: ShellLayoutState) throws -> NSWindow {
        let state = NativeApplicationState()
        state.beginSession("inspector-toolbar")
        try state.receiveProjection([
            "protocolVersion": 1, "sessionId": "inspector-toolbar", "sequence": 1,
            "projection": ["app": ["route": "editor", "loading": false,
                "project": ["id": "toolbar-project", "name": "工具栏核对"]],
                "editor": ["projectId": "toolbar-project", "canUndo": false, "canRedo": false]]
        ])
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800),
                              styleMask: [.titled, .closable, .resizable, .fullSizeContentView],
                              backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.toolbarStyle = .unified
        let root = NavigationSplitView {
            Text("故事大纲").toolbar(removing: .sidebarToggle)
        } detail: {
            Text("画布")
        }
        .toolbar { NativeEditorToolbar(state: state, layout: layout) }
        .inspector(isPresented: Binding(get: { layout.inspectorVisible }, set: { layout.inspectorVisible = $0 })) {
            Text("检查器").inspectorColumnWidth(min: 300, ideal: 360, max: 640)
                .toolbar { NativeInspectorToolbar(state: state, layout: layout) }
        }
        .navigationTitle(state.projectName)
        .frame(minWidth: 960, minHeight: 600)
        window.contentView = NSHostingView(rootView: root)
        window.orderFront(nil)
        return window
    }

    /// Readiness includes the real toolbar arrangement rather than merely nonzero frames.
    private func waitForInspector(in window: NSWindow, expectedWidth: CGFloat? = nil) async throws -> NSSplitView {
        try await NativeLayoutFixture.waitForInspector(in: window, visible: true, expectedWidth: expectedWidth)
        try await waitForTwoEnds(in: window, expectedWidth: expectedWidth)
        return try #require(window.contentView.flatMap { NativeLayoutFixture.inspectorSplit(in: $0) })
    }

    /// Divider and window changes finish only when the requested column width and all original invariants hold.
    private func waitForTwoEnds(in window: NSWindow, expectedWidth: CGFloat? = nil) async throws {
        try await NativeLayoutFixture.wait(in: window, for: "two-ended inspector toolbar") {
            guard let split = window.contentView.flatMap({ NativeLayoutFixture.inspectorSplit(in: $0) }),
                  let column = split.arrangedSubviews.last, !split.isSubviewCollapsed(column),
                  (300...640).contains(column.bounds.width),
                  let geometry = self.geometry(in: window) else { return false }
            return (expectedWidth.map { abs(column.bounds.width - $0) < 1 } ?? true)
                && geometry.aligned
        }
    }

    /// One independently observed native frame set supplies both readiness and the unchanged final assertions.
    private struct Geometry {
        /// The actual column bounds and public toolbar control frames share window coordinates.
        let column, creation, firstTool, lastTool: NSRect

        /// All seven original geometry conditions must hold; no timeout can turn a failed condition into success.
        var aligned: Bool {
            creation.minX >= column.minX && creation.minX - column.minX <= 20
                && lastTool.maxX <= column.maxX && column.maxX - lastTool.maxX <= 20
                && firstTool.minX - creation.maxX > 30
                && abs(creation.midY - lastTool.midY) < 1 && abs(creation.height - lastTool.height) < 1
        }
    }

    /// Assertions retain each original two-ended condition and its actual observed frame diagnostics.
    private func expectTwoEnds(in window: NSWindow) throws {
        let value = try #require(geometry(in: window))
        #expect(value.creation.minX >= value.column.minX)
        #expect(value.creation.minX - value.column.minX <= 20)
        #expect(value.lastTool.maxX <= value.column.maxX)
        #expect(value.column.maxX - value.lastTool.maxX <= 20)
        #expect(value.firstTool.minX - value.creation.maxX > 30)
        #expect(abs(value.creation.midY - value.lastTool.midY) < 1)
        #expect(abs(value.creation.height - value.lastTool.height) < 1)
    }

    /// Geometry comes from public native columns and controls, independently of placement constants.
    private func geometry(in window: NSWindow) -> Geometry? {
        guard let split = window.contentView.flatMap({ NativeLayoutFixture.inspectorSplit(in: $0) }),
              let column = split.arrangedSubviews.last,
              let creation = controlFrame(of: "添加节点", in: window),
              let firstTool = controlFrame(of: "设定集", in: window),
              let lastTool = controlFrame(of: "检查器", in: window) else { return nil }
        return Geometry(column: column.convert(column.bounds, to: nil),
                        creation: creation, firstTool: firstTool, lastTool: lastTool)
    }

    /// Public toolbar labels and group members expose the rendered control frame.
    private func frame(of label: String, in window: NSWindow) throws -> NSRect {
        try #require(controlFrame(of: label, in: window))
    }

    /// Polling a temporarily absent control must not record a Swift Testing failure.
    private func controlFrame(of label: String, in window: NSWindow) -> NSRect? {
        /// Group members expose the same public native item semantics as ungrouped buttons.
        func flatten(_ items: [NSToolbarItem]) -> [NSToolbarItem] {
            items.flatMap { [$0] + (($0 as? NSToolbarItemGroup).map { flatten($0.subitems) } ?? []) }
        }
        guard let item = flatten(window.toolbar?.visibleItems ?? []).first(where: { $0.label == label }),
              let view = item.view else { return nil }
        return view.convert(view.bounds, to: nil)
    }
}
