import AppKit
import QuartzCore
import SwiftUI

/// A window-attached receipt waits for real field layout and a subsequent display callback before continuing preparation.
struct NativeLayoutReceipt: NSViewRepresentable {
    let onReady: @MainActor () -> Void

    /// Only this transparent background probe owns its short-lived display callback.
    func makeNSView(context: Context) -> NSView { ReceiptView(onReady: onReady) }
    /// Refresh the current callback without creating another receipt for the same mounted probe.
    func updateNSView(_ view: NSView, context: Context) { (view as? ReceiptView)?.onReady = onReady }
    /// Teardown invalidates display callbacks before a detached project can report ready.
    static func dismantleNSView(_ view: NSView, coordinator: ()) { (view as? ReceiptView)?.cancel() }
}

/// The window's public display link keeps hidden preparation probes live without forcing a reentrant parent layout.
@MainActor
private final class ReceiptView: NSView {
    var onReady: @MainActor () -> Void
    private var link: CADisplayLink?
    private var completed = false
    private var laidOut = false

    /// Frame and callback are local to the enclosing inspector's native hosting tree.
    init(onReady: @escaping @MainActor () -> Void) { self.onReady = onReady; super.init(frame: .zero) }
    /// Storyboard decoding is unsupported for this programmatically owned layout probe.
    required init?(coder: NSCoder) { return nil }

    /// A display receipt is valid only after the attached field-tree background has actually laid out.
    override func layout() { super.layout(); laidOut = true }
    /// A window owns display cadence even when the prepared field tree is visually covered.
    override func viewDidMoveToWindow() {
        cancel()
        super.viewDidMoveToWindow()
        laidOut = false
        guard let window, !completed else { return }
        let link = window.displayLink(target: self, selector: #selector(displayReady(_:)))
        self.link = link
        link.add(to: .main, forMode: .common)
        needsLayout = true
    }

    /// One real display callback follows layout; it does not claim that pixels have physically reached the screen.
    @objc private func displayReady(_ displayLink: CADisplayLink) {
        guard displayLink === link, laidOut, !completed, window != nil, bounds.width > 0, bounds.height > 0 else { return }
        completed = true
        cancel()
        onReady()
    }

    /// Invalidating the link also breaks its target ownership; detached or failed preparation leaves no repeating callback.
    func cancel() { link?.invalidate(); link = nil }
}
