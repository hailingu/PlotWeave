import AppKit
import SwiftUI

/// The owner's Xcode reference is measured in layout points, rather than 2× screenshot pixels.
enum NativeWelcomeMetrics {
    /// The fixed outer welcome frame matches the owner's Retina reference.
    static let windowSize = NSSize(width: 480, height: 632)
    /// Open and create use the same point-sized capsule target.
    static let actionSize = NSSize(width: 107.5, height: 37.5)
    /// The top-left close target is circular and matches the action height.
    static let closeDiameter: CGFloat = 37.5
}

/// Presents a separate welcome card while the original window retains its persistent editing session.
struct NativeWelcomeWindow: NSViewRepresentable {
    /// Loading and home routes share the same presentation.
    let isWelcome: Bool
    /// Controls consume the shell's existing application owner.
    let state: NativeApplicationState
    /// The shell retains presentation independently of individual anchor updates.
    let controller: NativeWelcomeWindowController

    /// The shell owns presentation so tests can verify both windows without global window discovery.
    func makeCoordinator() -> NativeWelcomeWindowController { controller }

    /// Attachment can occur after the first SwiftUI update; report the actual writer window.
    func makeNSView(context: Context) -> NativeWelcomeWindowAnchor {
        let view = NativeWelcomeWindowAnchor()
        view.controller = context.coordinator
        view.isWelcome = isWelcome
        view.state = state
        return view
    }

    /// Routes update presentation without replacing the retained canvas or its coordinator.
    func updateNSView(_ view: NativeWelcomeWindowAnchor, context: Context) {
        view.isWelcome = isWelcome
        context.coordinator.update(window: view.window, isWelcome: isWelcome, state: state)
    }

    /// Removing the root cleans up its own card and window observation.
    static func dismantleNSView(_ view: NativeWelcomeWindowAnchor, coordinator: NativeWelcomeWindowController) {
        coordinator.update(window: nil, isWelcome: false)
    }
}

/// A noninteractive anchor keeps responder ownership with the controls and canvas.
final class NativeWelcomeWindowAnchor: NSView {
    /// Attachment reports cannot retain the shell's presentation owner.
    weak var controller: NativeWelcomeWindowController?
    /// The application projection belongs to the shell, rather than this anchor.
    weak var state: NativeApplicationState?
    /// SwiftUI can set the route before AppKit attaches the anchor to its window.
    var isWelcome = false

    /// Window replacement cleans up the old card before another writer becomes its close target.
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        controller?.update(window: window, isWelcome: isWelcome, state: state)
    }
}

/// Owns only welcome presentation; the original delegate remains the save and exit authority.
@MainActor
final class NativeWelcomeWindowController: NSObject, NSWindowDelegate {
    /// This control surface owns no WebView, storage service or writable document.
    private(set) var welcomeWindow: NSWindow?
    /// The retained editing window continues to own normal close approval.
    private weak var window: NSWindow?
    /// Coalescing uses the most recent attachment without retaining a discarded root.
    private weak var requestedWindow: NSWindow?
    /// The card uses the same application state for every control action.
    private var state: NativeApplicationState?
    /// The latest route decides whether pending presentation remains valid.
    private var isWelcome = false
    /// Only one deferred layout update may be queued at a time.
    private var updateScheduled = false
    /// Card creation waits for the original window's fullscreen exit notification.
    private var exitingFullScreen = false
    /// A previously hidden writer must stay hidden when the card is dismissed.
    private var restoreVisibility = false
    /// Presentation restores the writer's original opacity, rather than assuming an opaque owner.
    private var writerAlpha: CGFloat = 1
    /// Mouse exclusion lasts only while the welcome card owns interaction.
    private var writerIgnoresMouse = false
    /// The hidden writer's accessibility state is restored together with its input state.
    private var writerAccessibilityHidden = false
    /// Only the project's red title control returns home; normal welcome close retains its exit approval.
    private let projectClosing = NativeProjectWindowCloseController()

    /// Coalesces attachment and routes outside SwiftUI's current constraint pass.
    func update(window next: NSWindow?, isWelcome: Bool, state: NativeApplicationState? = nil) {
        requestedWindow = next
        self.isWelcome = isWelcome
        if let state { self.state = state }
        guard !updateScheduled else { return }
        updateScheduled = true
        DispatchQueue.main.async { self.applyPendingPresentation() }
    }

    /// A card close requests the writer's normal close and waits for its approved lifecycle event.
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard sender === welcomeWindow, let window else { return true }
        // The card can become main before launch subscription; report the still-mounted writer before closing.
        NotificationCenter.default.post(name: NativeApplicationDelegate.canvasWindowAttached, object: window)
        window.performClose(sender)
        return false
    }

    /// Only the latest attachment and route may create or dismiss the current card.
    private func applyPendingPresentation() {
        updateScheduled = false
        if window !== requestedWindow {
            dismiss(restoreWriter: true)
            stopObserving()
            window = requestedWindow
        }
        projectClosing.update(window: window, state: state)
        guard isWelcome, let window, let state else {
            dismiss(restoreWriter: true)
            stopObserving()
            return
        }
        guard welcomeWindow == nil, !exitingFullScreen else { return }
        if window.styleMask.contains(.fullScreen) {
            exitingFullScreen = true
            NotificationCenter.default.addObserver(
                self, selector: #selector(didExitFullScreen), name: NSWindow.didExitFullScreenNotification, object: window
            )
            window.toggleFullScreen(nil)
        } else {
            present(for: window, state: state)
        }
    }

    /// Stale fullscreen completion cannot present a card after returning to editing.
    @objc private func didExitFullScreen(_ notification: Notification) {
        stopObserving()
        guard isWelcome, let window, notification.object as? NSWindow === window, let state else { return }
        present(for: window, state: state)
    }

    /// Card geometry is independent of the editor's native split-column constraints.
    private func present(for window: NSWindow, state: NativeApplicationState) {
        let card = NSWindow(contentRect: NSRect(origin: .zero, size: NativeWelcomeMetrics.windowSize),
                            styleMask: [.titled, .closable, .fullSizeContentView], backing: .buffered, defer: false)
        card.isReleasedWhenClosed = false
        card.title = "PlotWeave"
        card.titleVisibility = .hidden
        card.titlebarAppearsTransparent = true
        card.collectionBehavior = [.fullScreenNone]
        card.isMovableByWindowBackground = true
        card.level = window.level
        for kind in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
            card.standardWindowButton(kind)?.isHidden = true
        }
        let content = NSHostingView(rootView: NativeHomeView(state: state).ignoresSafeArea())
        content.sizingOptions = []
        card.contentView = content
        let size = NativeWelcomeMetrics.windowSize
        card.setFrame(NSRect(x: window.frame.midX - size.width / 2, y: window.frame.midY - size.height / 2,
                             width: size.width, height: size.height), display: false)
        card.delegate = self
        welcomeWindow = card
        restoreVisibility = window.isVisible
        writerAlpha = window.alphaValue
        writerIgnoresMouse = window.ignoresMouseEvents
        writerAccessibilityHidden = window.isAccessibilityHidden()
        NotificationCenter.default.addObserver(
            self, selector: #selector(writerWillClose), name: NSWindow.willCloseNotification, object: window
        )
        // An ordered writer retains WebKit's initial viewport/layout callbacks; it accepts no input behind the card.
        window.alphaValue = 0
        window.ignoresMouseEvents = true
        window.setAccessibilityHidden(true)
        card.makeKeyAndOrderFront(nil)
    }

    /// Cleanup follows the writer's actual approved close, never a new approval shortcut.
    @objc private func writerWillClose(_ notification: Notification) {
        guard let window, notification.object as? NSWindow === window else { return }
        dismiss(restoreWriter: false)
        stopObserving()
    }

    /// Disposing the presentation-only card cannot close or resize the editing window.
    private func dismiss(restoreWriter: Bool) {
        guard let card = welcomeWindow else { return }
        welcomeWindow = nil
        card.delegate = nil
        card.close()
        card.contentView = nil
        window?.alphaValue = writerAlpha
        window?.ignoresMouseEvents = writerIgnoresMouse
        window?.setAccessibilityHidden(writerAccessibilityHidden)
        if restoreWriter, restoreVisibility { window?.makeKeyAndOrderFront(nil) }
        restoreVisibility = false
    }

    /// Replaced owners cannot receive stale fullscreen or close notifications.
    private func stopObserving() {
        NotificationCenter.default.removeObserver(self)
        exitingFullScreen = false
    }

    /// Releases notification subscriptions when the shell discards its presenter.
    isolated deinit { NotificationCenter.default.removeObserver(self) }
}

/// The card close control dispatches normal closing to its own window, including a pending save barrier.
struct NativeWelcomeCloseButton: NSViewRepresentable {
    /// An in-flight application action must finish before another close request is submitted.
    let enabled: Bool

    /// Public AppKit circular controls provide keyboard, accessibility and appearance behavior.
    func makeNSView(context: Context) -> NativeWelcomeCloseControl {
        let button = NativeWelcomeCloseControl()
        button.bezelStyle = .circular
        button.isBordered = false
        button.imagePosition = .imageOnly
        button.contentTintColor = .labelColor
        button.image = NSImage(systemSymbolName: "xmark", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 14, weight: .regular))
        button.setAccessibilityLabel("关闭欢迎页")
        button.toolTip = "关闭欢迎页"
        button.target = button
        button.action = #selector(NativeWelcomeCloseControl.closeWelcome)
        return button
    }

    /// Updates preserve the owning window and normal delegate action throughout application transitions.
    func updateNSView(_ button: NativeWelcomeCloseControl, context: Context) { button.isEnabled = enabled }
}

/// A local button target avoids closing whichever unrelated window happens to be key.
final class NativeWelcomeCloseControl: NSButton {
    /// The standard circular bezel has an intrinsic small diameter; draw the owner's full 37.5 pt target instead.
    override func draw(_ dirtyRect: NSRect) {
        let circle = NSBezierPath(ovalIn: bounds.insetBy(dx: 0.5, dy: 0.5))
        let fill: NSColor = window?.isKeyWindow == true && !isHighlighted ? .windowBackgroundColor : .quaternaryLabelColor
        fill.setFill()
        circle.fill()
        NSColor.separatorColor.setStroke()
        circle.lineWidth = 0.5
        circle.stroke()
        super.draw(dirtyRect)
    }

    /// Keyboard focus follows the visible circle rather than a rectangular cell boundary.
    override func drawFocusRingMask() { NSBezierPath(ovalIn: bounds).fill() }

    /// performClose respects NSWindowDelegate; direct close would bypass the authoritative flush barrier.
    @objc func closeWelcome() { window?.performClose(self) }
}
