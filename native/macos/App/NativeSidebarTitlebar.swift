import AppKit
import SwiftUI

/// A public titlebar accessory keeps the outline control above its column instead of the canvas toolbar.
struct NativeSidebarTitlebar: NSViewRepresentable {
    /// The split view and the title control consume one visibility preference.
    let layout: ShellLayoutState
    /// Nonediting routes have no outline control or titlebar reservation.
    let available: Bool
    /// Reading visibility in the root keeps external preference changes observable to this AppKit adapter.
    let expanded: Bool

    /// Each shell owns only its attached window's titlebar accessory.
    func makeCoordinator() -> NativeSidebarTitlebarController { NativeSidebarTitlebarController() }

    /// Attachment may occur after SwiftUI's initial toolbar and column construction.
    func makeNSView(context: Context) -> NativeSidebarTitlebarAnchor {
        let anchor = NativeSidebarTitlebarAnchor()
        anchor.controller = context.coordinator
        return anchor
    }

    /// Route and preference updates preserve the control's original window owner.
    func updateNSView(_ anchor: NativeSidebarTitlebarAnchor, context: Context) {
        context.coordinator.update(window: anchor.window, layout: layout, available: available)
    }

    /// A discarded root cannot leave controls on a different or retained window.
    static func dismantleNSView(_ anchor: NativeSidebarTitlebarAnchor, coordinator: NativeSidebarTitlebarController) {
        coordinator.update(window: nil, layout: nil, available: false)
    }
}

/// A noninteractive anchor reports actual attachment without changing the canvas responder chain.
final class NativeSidebarTitlebarAnchor: NSView {
    /// The SwiftUI coordinator owns the accessory; attachment does not retain it.
    weak var controller: NativeSidebarTitlebarController?

    /// The same retained root survives sidebar hiding and therefore keeps its reopen control.
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        controller?.attach(to: window)
    }
}

/// AppKit positions the accessory after the traffic lights; split geometry determines its trailing edge.
@MainActor
final class NativeSidebarTitlebarController: NSObject {
    /// Window and preference owners outlive presentation rather than being retained by it.
    private weak var window: NSWindow?
    /// A weak preference reference cannot keep a discarded root alive through its accessory.
    private weak var layout: ShellLayoutState?
    /// Route availability is independent of whether the user's sidebar is currently expanded.
    private var available = false
    /// Coalescing defers geometry changes beyond SwiftUI's current constraint pass.
    private var scheduled = false
    /// The original system toolbar continues to own editor actions and its title.
    private let accessory = NSTitlebarAccessoryViewController()
    /// A momentary glass button shares the editor toolbar's neutral appearance and native interaction semantics.
    private let button = NSButton()
    /// A not-yet-mounted toolbar still provides the standard circular control size.
    private let defaultDiameter: CGFloat = 36
    /// A small inset keeps the circle clear of the sidebar separator.
    private let inset: CGFloat = 8

    /// Native accessory construction uses no replacement toolbar delegate or private item identifiers.
    override init() {
        super.init()
        accessory.layoutAttribute = .left
        accessory.view = NSView(frame: NSRect(x: 0, y: 0, width: defaultDiameter + inset, height: defaultDiameter))
        button.frame = NSRect(x: 0, y: 0, width: defaultDiameter, height: defaultDiameter)
        button.bezelStyle = .glass
        button.borderShape = .circle
        button.setButtonType(.momentaryPushIn)
        button.imagePosition = .imageOnly
        button.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 18, weight: .regular)
        button.image = NSImage(systemSymbolName: "line.3.horizontal", accessibilityDescription: "故事大纲")
        button.title = ""
        button.setAccessibilityLabel("故事大纲")
        button.target = self
        button.action = #selector(toggleOutline)
        accessory.view.addSubview(button)
    }

    /// A newly attached window uses the preference and route already received from SwiftUI.
    func attach(to window: NSWindow?) { update(window: window, layout: layout, available: available) }

    /// Replacement and nonediting routes remove only this controller's own accessory.
    func update(window next: NSWindow?, layout: ShellLayoutState?, available: Bool) {
        if window !== next {
            detach()
            window = next
            if let next {
                NotificationCenter.default.addObserver(
                    self, selector: #selector(windowDidUpdate), name: NSWindow.didUpdateNotification, object: next
                )
                NotificationCenter.default.addObserver(
                    self, selector: #selector(windowDidUpdate), name: NSWindow.didResizeNotification, object: next
                )
                NotificationCenter.default.addObserver(
                    self, selector: #selector(splitDidResize), name: NSSplitView.didResizeSubviewsNotification, object: nil
                )
            }
        }
        self.layout = layout
        self.available = available
        scheduleLayout()
    }

    /// Resizing either the window or its sidebar reuses the actual system split-column geometry.
    @objc private func windowDidUpdate(_ notification: Notification) { scheduleLayout() }

    /// Only this shell's split changes may move its accessory; other windows keep their own layout.
    @objc private func splitDidResize(_ notification: Notification) {
        guard (notification.object as? NSSplitView)?.window === window else { return }
        scheduleLayout()
    }

    /// Pointer and keyboard activation toggle the existing preference, including when the column is hidden.
    @objc private func toggleOutline() { layout?.sidebarVisible.toggle(); scheduleLayout() }

    /// One deferred pass prevents titlebar geometry from changing during a SwiftUI update.
    private func scheduleLayout() {
        guard !scheduled else { return }
        scheduled = true
        DispatchQueue.main.async { [weak self] in self?.applyLayout() }
    }

    /// The accessory occupies only the leading column and remains compact when the column is collapsed.
    private func applyLayout() {
        scheduled = false
        guard let window, let layout, available else { removeAccessory(); return }
        if !window.titlebarAccessoryViewControllers.contains(where: { $0 === accessory }) {
            window.addTitlebarAccessoryViewController(accessory)
        }
        let toolbarFrame = window.toolbar?.visibleItems?.compactMap(\.view)
            .last(where: { $0.window === window && !$0.isHidden && $0.bounds.height > 0 })
            .map { $0.convert($0.bounds, to: nil) }
        let diameter = toolbarFrame?.height ?? defaultDiameter
        let height = max(diameter, window.frame.height - window.contentLayoutRect.maxY)
        button.toolTip = layout.sidebarVisible ? "隐藏故事大纲" : "显示故事大纲"
        let leading = accessory.view.convert(accessory.view.bounds, to: nil).minX
        let column = window.contentView.flatMap { navigationSplit(in: $0) }?.arrangedSubviews.first
        let edge = column.map { $0.convert($0.bounds, to: nil).maxX } ?? leading
        let width = layout.sidebarVisible ? max(diameter + inset, edge - leading) : diameter + inset
        if abs(accessory.view.frame.width - width) > 0.5 || abs(accessory.view.frame.height - height) > 0.5 {
            accessory.view.setFrameSize(NSSize(width: width, height: height))
        }
        let center = toolbarFrame.map { accessory.view.convert(NSPoint(x: 0, y: $0.midY), from: nil).y }
            ?? accessory.view.bounds.midY
        button.setFrameSize(NSSize(width: diameter, height: diameter))
        button.setFrameOrigin(NSPoint(x: width - diameter - inset, y: center - diameter / 2))
    }

    /// The innermost leading split owns navigation; the outer split belongs to the inspector.
    private func navigationSplit(in view: NSView) -> NSSplitView? {
        for child in view.subviews { if let split = navigationSplit(in: child) { return split } }
        if let split = view as? NSSplitView, split.isVertical, split.arrangedSubviews.count >= 2 { return split }
        return nil
    }

    /// Removal does not disturb unrelated titlebar accessories or the editor's window delegate.
    private func removeAccessory() {
        if let window, let index = window.titlebarAccessoryViewControllers.firstIndex(where: { $0 === accessory }) {
            window.removeTitlebarAccessoryViewController(at: index)
        }
    }

    /// A previous window cannot trigger updates after replacement or root disposal.
    private func detach() { removeAccessory(); NotificationCenter.default.removeObserver(self) }

    /// A released root leaves its window's original titlebar composition intact.
    isolated deinit { detach() }
}
