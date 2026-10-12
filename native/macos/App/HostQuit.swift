import AppKit

/// One pending user intent covers close, Command-Q and Dock quit before or after listener registration.
@MainActor
final class HostQuitController {
    /// Application owner supplies the final close/terminate action after the Web flush succeeds.
    enum Intent: Equatable { case close, terminate }
    /// Process-wide production lifecycle; tests inject an independent controller.
    static let shared = HostQuitController()
    /// Pending user intent is retained across startup and listener re-registration.
    private(set) var pendingIntent: Intent?
    /// No event is emitted before the Web confirms its listener is installed.
    private var listenerReady = false
    /// Event delivery is owned by this controller and replaced on a new connection.
    private var eventTask: Task<Void, Never>?
    /// Main-actor event adapter keeps WebKit references on the UI owner rather than background services.
    var sendEvent: ((String, HostJSON) async throws -> Void)?
    /// Final system mutation is invoked only for an already-pending, successfully flushed intent.
    var onApproved: ((Intent) -> Void)?

    /// Records user intent before any asynchronous bridge work; retries are explicit user actions.
    func request(_ intent: Intent) {
        if pendingIntent != .terminate { pendingIntent = intent }
        if listenerReady { emitRequested() }
    }

    /// Keeps startup requests buffered until the current page registers the quit listener.
    func resetListener() { listenerReady = false }

    /// The acknowledgement releases one buffered request after listener registration.
    func acknowledgeListener() {
        listenerReady = true
        if pendingIntent != nil { emitRequested() }
    }

    /// Refuses arbitrary app_exit commands; the current page must finish the pending user's flush.
    func approve() throws {
        guard let intent = pendingIntent else {
            throw HostFailure(code: "PW_NO_QUIT_REQUEST", message: "没有待完成的退出请求")
        }
        guard listenerReady else {
            throw HostFailure(code: "PW_QUIT_LISTENER_NOT_READY", message: "画布尚未注册退出保存监听")
        }
        pendingIntent = nil
        onApproved?(intent)
    }

    /// Failures retain the pending intent and window; the next explicit close/quit retries the flush.
    private func emitRequested() {
        guard let sendEvent else { return }
        eventTask?.cancel()
        eventTask = Task { @MainActor in
            do { try await sendEvent("app-quit-requested", .object([:])) }
            catch { NSLog("PlotWeave quit bridge delivery failed: %@", error.localizedDescription) }
        }
    }
}

/// AppKit adapts every normal exit entry to the same Web-owned flush barrier.
@MainActor
final class NativeApplicationDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    /// The host signals actual content attachment even when AppKit's main-window notification precedes SwiftUI mounting.
    static let canvasWindowAttached = Notification.Name("PlotWeaveCanvasWindowAttached")
    private let attachExistingMainWindow: Bool
    /// Explicit lifecycle injection keeps tests independent of the running app's close intent.
    private let quit: HostQuitController
    /// A successfully flushed writer leaves no page that a later Dock quit needs to consult.
    private var closedAfterFlush = false
    /// Weak single-window ownership does not retain a closed canvas or create another writer.
    private weak var window: NSWindow?
    /// Approved actions consume one close/termination permit.
    private var permitClose = false
    private var permitTerminate = false
    /// Executes only an approved system termination; isolated tests observe it without quitting their host.
    private var terminateApplication: () -> Void = { NSApp.terminate(nil) }

    /// SwiftUI's delegate adaptor constructs NSObject through its actual zero-argument initializer.
    override init() { quit = .shared; attachExistingMainWindow = true; super.init() }

    /// Real-window tests use an isolated controller without changing the running app's exit lifecycle.
    init(quit: HostQuitController, terminateApplication: (() -> Void)? = nil) {
        self.quit = quit
        attachExistingMainWindow = false
        super.init()
        if let terminateApplication { self.terminateApplication = terminateApplication }
    }

    /// Attaches the single main window and supplies the controller's final AppKit action.
    func applicationDidFinishLaunching(_ notification: Notification) {
        quit.onApproved = { [weak self] intent in self?.finish(intent) }
        NotificationCenter.default.addObserver(
            self, selector: #selector(attachMainWindow(_:)),
            name: NSWindow.didBecomeMainNotification, object: nil
        )
        NotificationCenter.default.addObserver(
            self, selector: #selector(attachMainWindow(_:)), name: Self.canvasWindowAttached, object: nil
        )
        if attachExistingMainWindow, let main = NSApp.mainWindow { attach(main) }
    }

    /// AppKit posts main-window notifications on the UI thread; the selector retains no cross-actor payload.
    @objc private func attachMainWindow(_ notification: Notification) {
        guard let window = notification.object as? NSWindow else { return }
        attach(window)
    }

    /// Tracks only the application window, excluding native save panels and test fixture windows.
    private func attach(_ window: NSWindow) {
        guard !(window is NSPanel), window.sheetParent == nil,
              self.window == nil || self.window === window,
              window.identifier?.rawValue == "main" || ownsCanvas(window.contentView) else { return }
        closedAfterFlush = false
        self.window = window
        window.delegate = self
    }

    /// The actual host view supplies a stable native marker even when SwiftUI decorates its scene identifier.
    private func ownsCanvas(_ view: NSView?) -> Bool {
        guard let view else { return false }
        return view.identifier?.rawValue == "plotweave.canvas" || view.subviews.contains(where: { ownsCanvas($0) })
    }

    /// Window close waits for the same listener/flush protocol used by application quit.
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if permitClose { permitClose = false; closedAfterFlush = true; return true }
        window = sender
        quit.request(.close)
        return false
    }

    /// Releases the tracked writer only after its actual AppKit close lifecycle finishes.
    func windowWillClose(_ notification: Notification) {
        guard let closing = notification.object as? NSWindow, closing === window else { return }
        window = nil
    }

    /// Cancels the current system quit while the Web flushes, keeping AppKit's normal event loop usable on failure.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if permitTerminate || closedAfterFlush && window == nil { return .terminateNow }
        quit.request(.terminate)
        return .terminateCancel
    }

    /// Successful flush starts a fresh permitted termination; failed saves never leave AppKit awaiting a deferred reply.
    private func finish(_ intent: HostQuitController.Intent) {
        switch intent {
        case .close:
            permitClose = true
            window?.performClose(nil)
        case .terminate:
            permitTerminate = true
            terminateApplication()
        }
    }

    /// Releases the notification subscription when the application owner is discarded.
    isolated deinit {
        NotificationCenter.default.removeObserver(self)
    }
}
