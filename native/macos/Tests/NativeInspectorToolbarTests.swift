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
        try await Task.sleep(for: .milliseconds(400))
        try expectTwoEnds(in: window)
        split.setPosition(window.contentLayoutRect.width - 300, ofDividerAt: 0)
        try await Task.sleep(for: .milliseconds(400))
        try expectTwoEnds(in: window)
        layout.toggleInspector()
        try await Task.sleep(for: .milliseconds(400))
        #expect(try frame(of: "添加节点", in: window).width > 0)
        #expect(try frame(of: "检查器", in: window).width > 0)
        layout.toggleInspector()
        _ = try await waitForInspector(in: window)
        try await Task.sleep(for: .milliseconds(400))
        try expectTwoEnds(in: window)
        window.setContentSize(NSSize(width: 1400, height: 800))
        split.setPosition(900, ofDividerAt: 0)
        try await Task.sleep(for: .milliseconds(400))
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

    /// Concurrent native suites may defer initial presentation; readiness never relaxes the geometry assertions.
    private func waitForInspector(in window: NSWindow) async throws -> NSSplitView {
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while ContinuousClock.now < deadline {
            if let root = window.contentView, let split = inspectorSplit(in: root),
               let column = split.arrangedSubviews.last, (300...640).contains(column.bounds.width),
               let creation = try? frame(of: "添加节点", in: window), creation.width > 0,
               let last = try? frame(of: "检查器", in: window), last.width > 0 { return split }
            try await Task.sleep(for: .milliseconds(30))
        }
        throw HostFailure(code: "PW_TEST_NATIVE_LAYOUT_TIMEOUT", message: "隔离检查器及工具栏未在期限内就绪")
    }

    /// Geometry comes from actual native columns and controls, independently of placement constants.
    private func expectTwoEnds(in window: NSWindow) throws {
        let split = try #require(window.contentView.flatMap { inspectorSplit(in: $0) })
        let column = try #require(split.arrangedSubviews.last)
        let columnFrame = column.convert(column.bounds, to: nil)
        let creation = try frame(of: "添加节点", in: window)
        let firstTool = try frame(of: "设定集", in: window)
        let lastTool = try frame(of: "检查器", in: window)
        #expect(creation.minX >= columnFrame.minX)
        #expect(creation.minX - columnFrame.minX <= 20)
        #expect(lastTool.maxX <= columnFrame.maxX)
        #expect(columnFrame.maxX - lastTool.maxX <= 20)
        #expect(firstTool.minX - creation.maxX > 30)
        #expect(abs(creation.midY - lastTool.midY) < 1)
        #expect(abs(creation.height - lastTool.height) < 1)
    }

    /// The outer vertical split owns the full-height inspector; inner navigation splits own the outline.
    private func inspectorSplit(in view: NSView) -> NSSplitView? {
        if let split = view as? NSSplitView, split.isVertical, split.arrangedSubviews.count == 2 { return split }
        for child in view.subviews { if let split = inspectorSplit(in: child) { return split } }
        return nil
    }

    /// Public toolbar labels and group members expose the rendered control frame.
    private func frame(of label: String, in window: NSWindow) throws -> NSRect {
        /// Group members expose the same public native item semantics as ungrouped buttons.
        func flatten(_ items: [NSToolbarItem]) -> [NSToolbarItem] {
            items.flatMap { [$0] + (($0 as? NSToolbarItemGroup).map { flatten($0.subitems) } ?? []) }
        }
        let item = try #require(flatten(window.toolbar?.visibleItems ?? []).first { $0.label == label })
        let view = try #require(item.view)
        return view.convert(view.bounds, to: nil)
    }
}
