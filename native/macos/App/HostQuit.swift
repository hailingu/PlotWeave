import AppKit

/// One pending user intent covers close, Command-Q and Dock quit before or after listener registration.
@MainActor
final class HostQuitController {
    /// Application owner supplies the final close/terminate action after the Web flush succeeds.
    enum Intent: Equatable { case close, terminate }
    /// Process-wide production lifecycle; tests inject an independent controller.
    static let shared = HostQuitController()
    /// Startup intent survives first connection; a replaced ready page loses its old pending authority.
    private(set) var pendingIntent: Intent?
    /// No event is emitted before the Web confirms its listener is installed.
    private(set) var listenerReady = false
    /// Event delivery is owned by this controller and replaced on a new connection.
    private var eventTask: Task<Void, Never>?
    /// Main-actor event adapter keeps WebKit references on the UI owner rather than background services.
    var sendEvent: ((String, HostJSON) async throws -> Void)?
    /// Final system mutation is invoked only for an already-pending, successfully flushed intent.
    var onApproved: ((Intent) -> Void)?
    /// Failure cancels only the pending user's intent; native termination replies remain owned by the delegate.
    var onCancelled: ((Intent) -> Void)?
    /// Visible degraded decision when no listener can confirm the save state; the delegate presents the warning.
    var onUnavailable: ((Intent) -> Void)?
    /// A quit event could not be delivered while the page may still be alive; cancel this attempt and surface the error.
    var onDeliveryFailure: ((Intent, Error) -> Void)?
    /// A failed canvas keeps the normal listener/flush path unavailable until a page acknowledges its listener again.
    private(set) var canvasUnavailable = false
    /// At most one visible degraded confirmation is active; later requests do not stack alerts.
    private var unavailablePromptActive = false

    /// Records user intent before any asynchronous bridge work; retries are explicit user actions.
    /// A known canvas failure cannot silently buffer: the delegate shows a visible continue/cancel decision.
    func request(_ intent: Intent) {
        guard !unavailablePromptActive else { return }
        if pendingIntent != .terminate { pendingIntent = intent }
        if canvasUnavailable {
            presentUnavailablePrompt()
        } else if listenerReady {
            emitRequested()
        }
    }

    /// A failed canvas cannot provide a save listener: keep the pending user intent and surface it visibly.
    func canvasFailed() {
        canvasUnavailable = true
        listenerReady = false
        eventTask?.cancel()
        presentUnavailablePrompt()
    }

    /// Startup buffering survives first connection; replacement of a ready page cancels its outstanding decision.
    /// An active degraded decision keeps its pending intent: the visible warning owns it until the user answers.
    func resetListener() {
        if listenerReady && !unavailablePromptActive { cancel() }
        listenerReady = false
        eventTask?.cancel()
    }

    /// The acknowledgement releases one buffered request after listener registration.
    /// It must not clear or replay an active degraded decision: the warning's modal loop can deliver this
    /// acknowledgement before the user answers, and replaying would let the recovered page terminate early.
    func acknowledgeListener() {
        listenerReady = true
        guard !unavailablePromptActive else { return }
        canvasUnavailable = false
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
        consume(intent)
    }

    /// Resolves the visible degraded decision; only an explicit user approval releases close/terminate.
    /// A listener recovered while the warning was open is cleared only after the user answers, never by
    /// replaying the request behind the modal.
    func resolveUnavailable(approved: Bool) {
        unavailablePromptActive = false
        guard let intent = pendingIntent else {
            if listenerReady { canvasUnavailable = false }
            return
        }
        if approved {
            consume(intent)
        } else {
            cancel()
            if listenerReady { canvasUnavailable = false }
        }
    }

    /// Failure is idempotent, preserves the window and never requires a working flush listener.
    func cancel() {
        guard let intent = pendingIntent else { return }
        pendingIntent = nil
        unavailablePromptActive = false
        eventTask?.cancel()
        onCancelled?(intent)
    }

    /// One approval consumes the pending intent and releases the original AppKit action.
    private func consume(_ intent: Intent) {
        pendingIntent = nil
        unavailablePromptActive = false
        eventTask?.cancel()
        onApproved?(intent)
    }

    /// Presents the degraded confirmation once; a pending request owns the visible decision.
    private func presentUnavailablePrompt() {
        guard !unavailablePromptActive, let intent = pendingIntent else { return }
        unavailablePromptActive = true
        onUnavailable?(intent)
    }

    /// Delivery failures settle the native decision; cancelled old deliveries cannot reject a newer intent.
    /// The page may still be alive, so this is a visible retryable failure rather than a canvas-failure degrade.
    private func emitRequested() {
        let deliver = sendEvent
        eventTask?.cancel()
        eventTask = Task { @MainActor in
            do {
                guard let deliver else { throw HostFailure(code: "PW_PAGE_UNAVAILABLE", message: "退出事件传输不可用") }
                try await deliver("app-quit-requested", .object([:]))
            } catch {
                guard !Task.isCancelled, let intent = pendingIntent else { return }
                NSLog("PlotWeave quit bridge delivery failed: %@", error.localizedDescription)
                cancel()
                onDeliveryFailure?(intent, error)
            }
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
    /// Only an actual terminateLater return authorizes one deferred AppKit reply.
    private var awaitingTermination = false
    /// Executes only an approved system termination; isolated tests observe it without quitting their host.
    private var terminateApplication: () -> Void = { NSApp.terminate(nil) }
    /// Tests observe AppKit's deferred decision without actually terminating their process.
    private var replyToTermination: (Bool) -> Void = { NSApp.reply(toApplicationShouldTerminate: $0) }
    /// Visible warning before a degraded close/quit when the canvas cannot provide its flush listener.
    private let presentUnavailablePrompt: (HostQuitController.Intent) -> Bool
    /// Visible retryable diagnostic after a quit event could not be delivered; the page may still be usable.
    private let presentDeliveryFailure: (Error) -> Void

    /// SwiftUI's delegate adaptor constructs NSObject through its actual zero-argument initializer.
    override init() {
        quit = .shared
        attachExistingMainWindow = true
        presentUnavailablePrompt = Self.presentUnavailableAlert
        presentDeliveryFailure = Self.presentDeliveryFailureAlert
        super.init()
    }

    /// Real-window tests use an isolated controller without changing the running app's exit lifecycle.
    /// The test initializer defaults to no modal for either degraded decision; lifecycle tests inject their
    /// own presenters when they verify the visible feedback. Production always uses the real alerts.
    init(
        quit: HostQuitController,
        terminateApplication: (() -> Void)? = nil,
        replyToTermination: ((Bool) -> Void)? = nil,
        presentUnavailablePrompt: ((HostQuitController.Intent) -> Bool)? = nil,
        presentDeliveryFailure: ((Error) -> Void)? = nil
    ) {
        self.quit = quit
        attachExistingMainWindow = false
        self.presentUnavailablePrompt = presentUnavailablePrompt ?? { _ in false }
        self.presentDeliveryFailure = presentDeliveryFailure ?? { _ in }
        super.init()
        if let terminateApplication { self.terminateApplication = terminateApplication }
        if let replyToTermination { self.replyToTermination = replyToTermination }
    }

    /// Attaches the single main window and supplies the controller's final AppKit action.
    func applicationDidFinishLaunching(_ notification: Notification) {
        quit.onApproved = { [weak self] intent in self?.finish(intent) }
        quit.onCancelled = { [weak self] intent in self?.cancel(intent) }
        quit.onUnavailable = { [weak self] intent in
            guard let self else { return }
            let approved = self.presentUnavailablePrompt(intent)
            // The alert runs inside AppKit's close/terminate decision; resolve after that decision returns.
            DispatchQueue.main.async { [weak self] in self?.quit.resolveUnavailable(approved: approved) }
        }
        quit.onDeliveryFailure = { [weak self] _, error in self?.presentDeliveryFailure(error) }
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

    /// Ready pages defer the original system sequence; startup cannot enter a modal wait before a listener exists.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if permitTerminate || closedAfterFlush && window == nil { return .terminateNow }
        awaitingTermination = quit.listenerReady
        quit.request(.terminate)
        return awaitingTermination ? .terminateLater : .terminateCancel
    }

    /// Visible degraded decision used in production; tests inject a closure instead of running a modal alert.
    /// Continuing explicitly accepts losing edits that the unavailable page cannot confirm as flushed.
    private static func presentUnavailableAlert(_ intent: HostQuitController.Intent) -> Bool {
        let alert = NSAlert()
        alert.messageText = intent == .close ? "画布不可用，仍要关闭窗口吗？" : "画布不可用，仍要退出 PlotWeave 吗？"
        alert.informativeText =
            "画布未加载完成，应用无法确认未保存的编辑是否已落盘。继续将放弃本次会话中未保存的内容；"
            + "取消后保留窗口并可重试加载画布。"
        alert.alertStyle = .warning
        alert.addButton(withTitle: intent == .close ? "关闭窗口" : "退出")
        alert.addButton(withTitle: "取消")
        return alert.runModal() == .alertFirstButtonReturn
    }

    /// Visible retryable failure for a quit event that never reached the live page; the window stays open.
    private static func presentDeliveryFailureAlert(_ error: Error) {
        let alert = NSAlert()
        alert.messageText = "退出请求未能送达画布"
        alert.informativeText =
            "应用已取消本次关闭／退出，窗口保持打开。请重试；若问题持续，请重新加载画布。\n\n"
            + error.localizedDescription
        alert.alertStyle = .warning
        alert.addButton(withTitle: "好")
        alert.runModal()
    }

    /// Successful flush approves the original system sequence; only an already-cancelled startup quit is restarted.
    private func finish(_ intent: HostQuitController.Intent) {
        switch intent {
        case .close:
            permitClose = true
            window?.performClose(nil)
        case .terminate:
            permitTerminate = true
            if awaitingTermination {
                awaitingTermination = false
                replyToTermination(true)
            } else { terminateApplication() }
        }
    }

    /// Failed save, delivery or page replacement completes a deferred system decision exactly once.
    private func cancel(_ intent: HostQuitController.Intent) {
        guard intent == .terminate, awaitingTermination else { return }
        awaitingTermination = false
        replyToTermination(false)
    }

    /// Releases the notification subscription when the application owner is discarded.
    isolated deinit {
        NotificationCenter.default.removeObserver(self)
    }
}
