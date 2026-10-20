import AppKit
import WebKit
@testable import PlotWeaveNative

/// Observable native layout completion for disposable windows; deadlines only diagnose a stalled transition.
@MainActor
enum NativeLayoutFixture {
    /// Flush pending layout and yield until the caller's actual UI condition holds.
    static func wait(in window: NSWindow, for operation: String, until predicate: () throws -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while ContinuousClock.now < deadline {
            window.contentView?.layoutSubtreeIfNeeded()
            if try predicate() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        throw HostFailure(code: "PW_TEST_NATIVE_LAYOUT_TIMEOUT", message: "Timed out awaiting \(operation): \(summary(in: window))")
    }

    /// A visible inspector must be fully revealed; a sliver during expansion is not completion.
    /// Canvas callers also wait for the released trailing space while retaining the visible sidebar.
    static func waitForInspector(in window: NSWindow, visible: Bool, expectedWidth: CGFloat? = nil,
                                 canvas: WKWebView? = nil) async throws {
        try await wait(in: window, for: "inspector visible=\(visible)") {
            guard let split = window.contentView.flatMap({ inspectorSplit(in: $0) }),
                  let column = split.arrangedSubviews.last else { return !visible && canvas == nil }
            if !visible {
                guard split.isSubviewCollapsed(column) || column.isHiddenOrHasHiddenAncestor else { return false }
                guard let canvas else { return true }
                guard let detail = split.arrangedSubviews.first, canvas.isDescendant(of: detail) else { return false }
                let detailFrame = detail.convert(detail.bounds, to: split)
                let canvasFrame = canvas.convert(canvas.bounds, to: split)
                return canvasFrame.width > 0 && split.bounds.width > 0
                    && abs(detailFrame.width - split.bounds.width) < 1
                    && abs(detailFrame.maxX - split.bounds.maxX) < 1
                    && abs(canvasFrame.maxX - split.bounds.maxX) < 1
            }
            let width = column.bounds.width
            let unclipped = column.bounds.intersection(column.visibleRect).width
            return !split.isSubviewCollapsed(column) && !column.isHiddenOrHasHiddenAncestor
                && (300...640).contains(width) && abs(unclipped - width) < 1
                && (expectedWidth.map { abs(width - $0) < 1 } ?? true)
        }
    }

    /// The navigation split contains the canvas in its trailing column, independently of inspector nesting.
    static func waitForSidebar(in window: NSWindow, canvas: WKWebView, visible: Bool,
                               expectedCanvasWidth: CGFloat? = nil) async throws {
        try await wait(in: window, for: "sidebar visible=\(visible)") {
            var ancestor = canvas.superview
            while let view = ancestor {
                if let split = view as? NSSplitView, split.isVertical, split.arrangedSubviews.count == 2,
                   let detail = split.arrangedSubviews.last, canvas.isDescendant(of: detail),
                   let sidebar = split.arrangedSubviews.first {
                    if !visible {
                        let collapsed = split.isSubviewCollapsed(sidebar) || sidebar.isHiddenOrHasHiddenAncestor
                        let targetWidth = split.bounds.width
                        return collapsed && targetWidth > 0
                            && abs(detail.bounds.width - targetWidth) < 1
                            && abs(canvas.bounds.width - targetWidth) < 1
                    }
                    return !split.isSubviewCollapsed(sidebar) && !sidebar.isHiddenOrHasHiddenAncestor && sidebar.bounds.width > 1
                        && (expectedCanvasWidth.map { abs(canvas.bounds.width - $0) < 1 } ?? true)
                }
                ancestor = view.superview
            }
            return false
        }
    }

    /// Public split geometry avoids private hosting class names and counts only real arranged columns.
    static func inspectorSplit(in view: NSView) -> NSSplitView? {
        if let split = view as? NSSplitView, split.isVertical, split.arrangedSubviews.count == 2 { return split }
        return view.subviews.lazy.compactMap { inspectorSplit(in: $0) }.first
    }

    /// Timeout diagnostics retain actual column widths and collapse flags without snapshots or user content.
    private static func summary(in window: NSWindow) -> String {
        /// Nested splits and canvas frames expose independent native transitions without private class names.
        func splits(in view: NSView) -> [String] {
            let own = (view as? NSSplitView).map { split in
                "split vertical=\(split.isVertical) columns=" + split.arrangedSubviews.map {
                    "frame=\($0.frame)/visible=\($0.visibleRect)/collapsed=\(split.isSubviewCollapsed($0))/hidden=\($0.isHidden)"
                }.joined(separator: ",")
            }.map { [$0] } ?? []
            let canvas = (view as? WKWebView).map {
                ["canvas bounds=\($0.bounds)/windowFrame=\($0.convert($0.bounds, to: nil))"]
            } ?? []
            return own + canvas + view.subviews.flatMap { splits(in: $0) }
        }
        return window.contentView.map { splits(in: $0).joined(separator: "; ") } ?? "content view unavailable"
    }
}
