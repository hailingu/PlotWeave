import AppKit
import Testing
@testable import PlotWeaveNative

/// Quit buffering must leave AppKit's normal event loop available until the Web approves termination.
@MainActor
@Suite(.serialized)
struct NativeQuitRecoveryTests {
    /// A failed listener handshake leaves a buffered intent, without a deferred AppKit termination to complete.
    @Test func listenerInitializationFailureKeepsApplicationInteractive() throws {
        let quit = HostQuitController()
        var terminations = 0
        let delegate = NativeApplicationDelegate(quit: quit, terminateApplication: { terminations += 1 })
        delegate.applicationDidFinishLaunching(Notification(name: NSApplication.didFinishLaunchingNotification))
        #expect(delegate.applicationShouldTerminate(NSApplication.shared) == .terminateCancel)
        #expect(throws: HostFailure.self) { try quit.approve() }
        #expect(quit.pendingIntent == .terminate)
        #expect(terminations == 0)
        // Explicit retries still wait for the listener, even when the first request preceded startup.
        #expect(delegate.applicationShouldTerminate(NSApplication.shared) == .terminateCancel)
        quit.acknowledgeListener()
        try quit.approve()
        #expect(terminations == 1)
        #expect(delegate.applicationShouldTerminate(NSApplication.shared) == .terminateNow)
        #expect(quit.pendingIntent == nil)
    }

    /// Failed flush sends one false reply; the next successful intent replies true to the same system protocol.
    @Test func failedFlushCancelsDeferredTerminationAndRetryApproves() async throws {
        let quit = HostQuitController()
        let services = NativeHostServices(dataRoot: nil, quit: quit)
        var replies: [Bool] = []
        let delegate = NativeApplicationDelegate(quit: quit, terminateApplication: {}, replyToTermination: { replies.append($0) })
        delegate.applicationDidFinishLaunching(Notification(name: NSApplication.didFinishLaunchingNotification))
        quit.sendEvent = { _, _ in }
        quit.acknowledgeListener()
        #expect(delegate.applicationShouldTerminate(NSApplication.shared) == .terminateLater)
        let cancel = HostRequest(protocolVersion: 1, sessionId: "fixture", requestId: "cancel", command: "app_exit", args: ["cancel": .bool(true)])
        _ = try await services.perform(cancel)
        #expect(replies == [false])
        #expect(quit.pendingIntent == nil)
        _ = try await services.perform(cancel)
        #expect(replies == [false])
        #expect(delegate.applicationShouldTerminate(NSApplication.shared) == .terminateLater)
        try quit.approve()
        #expect(replies == [false, true])
        #expect(delegate.applicationShouldTerminate(NSApplication.shared) == .terminateNow)
    }

    /// Native delivery failure cancels this attempt with a visible diagnostic and keeps listener authority for a retry.
    @Test func bridgeDeliveryFailureRetainsAnInteractiveRetry() async throws {
        let quit = HostQuitController()
        var replies: [Bool] = []
        var failures: [String] = []
        var delivered: CheckedContinuation<Void, Never>?
        quit.sendEvent = { _, _ in
            delivered?.resume()
            delivered = nil
            throw HostFailure(code: "PW_PAGE_UNAVAILABLE", message: "fixture delivery failure")
        }
        let delegate = NativeApplicationDelegate(
            quit: quit,
            terminateApplication: {},
            replyToTermination: { replies.append($0) },
            presentDeliveryFailure: { failures.append($0.localizedDescription) }
        )
        delegate.applicationDidFinishLaunching(Notification(name: NSApplication.didFinishLaunchingNotification))
        quit.acknowledgeListener()
        await withCheckedContinuation { continuation in
            delivered = continuation
            #expect(delegate.applicationShouldTerminate(NSApplication.shared) == .terminateLater)
        }
        try await Task.sleep(for: .milliseconds(50))
        #expect(failures == ["fixture delivery failure"])
        #expect(replies == [false])
        #expect(quit.pendingIntent == nil)
        #expect(quit.listenerReady)
        #expect(!quit.canvasUnavailable)
        quit.sendEvent = { _, _ in }
        #expect(delegate.applicationShouldTerminate(NSApplication.shared) == .terminateLater)
        try quit.approve()
        #expect(replies == [false, true])
    }

    /// A ready page replaced during a quit cancels the old deferred decision before the new listener gains authority.
    @Test func pageReplacementCancelsItsDeferredTermination() {
        let quit = HostQuitController()
        var replies: [Bool] = []
        let delegate = NativeApplicationDelegate(quit: quit, terminateApplication: {}, replyToTermination: { replies.append($0) })
        delegate.applicationDidFinishLaunching(Notification(name: NSApplication.didFinishLaunchingNotification))
        quit.acknowledgeListener()
        #expect(delegate.applicationShouldTerminate(NSApplication.shared) == .terminateLater)
        quit.resetListener()
        #expect(replies == [false])
        #expect(quit.pendingIntent == nil)
        #expect(throws: HostFailure.self) { try quit.approve() }
    }

    /// Malformed failure signals cannot consume an intent or approve termination.
    @Test func invalidCancelArgumentPreservesPendingIntent() async throws {
        let quit = HostQuitController()
        let services = NativeHostServices(dataRoot: nil, quit: quit)
        quit.request(.terminate)
        let request = HostRequest(protocolVersion: 1, sessionId: "fixture", requestId: "invalid", command: "app_exit", args: ["cancel": .string("true")])
        do {
            _ = try await services.perform(request)
            Issue.record("non-boolean cancellation was accepted")
        } catch let failure as HostFailure { #expect(failure.code == "PW_INVALID_REQUEST") }
        #expect(quit.pendingIntent == .terminate)
    }

    /// A failed canvas turns an AppKit terminate request into a visible confirmation; approval degrades explicitly.
    @Test func canvasFailureTerminatePromptApprovesDegradedTermination() async throws {
        let quit = HostQuitController()
        var terminations = 0
        var prompts: [HostQuitController.Intent] = []
        let delegate = NativeApplicationDelegate(
            quit: quit,
            terminateApplication: { terminations += 1 },
            presentUnavailablePrompt: { intent in prompts.append(intent); return true }
        )
        delegate.applicationDidFinishLaunching(Notification(name: NSApplication.didFinishLaunchingNotification))
        quit.canvasFailed()
        #expect(delegate.applicationShouldTerminate(NSApplication.shared) == .terminateCancel)
        #expect(prompts == [.terminate])
        try await Task.sleep(for: .milliseconds(50))
        #expect(terminations == 1)
        #expect(quit.pendingIntent == nil)
    }

    /// Cancelling the visible degraded confirmation keeps the application running with no pending un-flushed intent.
    @Test func canvasFailureTerminatePromptCancellationKeepsRunning() async throws {
        let quit = HostQuitController()
        var terminations = 0
        var prompts: [HostQuitController.Intent] = []
        let delegate = NativeApplicationDelegate(
            quit: quit,
            terminateApplication: { terminations += 1 },
            presentUnavailablePrompt: { intent in prompts.append(intent); return false }
        )
        delegate.applicationDidFinishLaunching(Notification(name: NSApplication.didFinishLaunchingNotification))
        quit.canvasFailed()
        #expect(delegate.applicationShouldTerminate(NSApplication.shared) == .terminateCancel)
        #expect(prompts == [.terminate])
        try await Task.sleep(for: .milliseconds(50))
        #expect(terminations == 0)
        #expect(quit.pendingIntent == nil)
        #expect(quit.canvasUnavailable)
    }

    /// Window close follows the same visible degraded decision and only closes after explicit approval.
    @Test func canvasFailureClosePromptApprovesWriterClose() async throws {
        let quit = HostQuitController()
        var prompts: [HostQuitController.Intent] = []
        let delegate = NativeApplicationDelegate(
            quit: quit,
            presentUnavailablePrompt: { intent in prompts.append(intent); return true }
        )
        delegate.applicationDidFinishLaunching(Notification(name: NSApplication.didFinishLaunchingNotification))
        let window = NSWindow(
            contentRect: NSRect(x: 60, y: 60, width: 900, height: 650),
            styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false
        )
        window.isReleasedWhenClosed = false
        window.delegate = delegate
        window.makeKeyAndOrderFront(nil)
        quit.canvasFailed()
        #expect(!delegate.windowShouldClose(window))
        #expect(prompts == [.close])
        try await Task.sleep(for: .milliseconds(50))
        #expect(!window.isVisible)
        #expect(quit.pendingIntent == nil)
    }

    /// A fresh system terminate request behind a visible warning must be cancelled, not suspended without a reply.
    @Test func activeWarningCancelsNewTerminateRequestWithoutSuspendingAppKit() {
        let quit = HostQuitController()
        var prompts: [HostQuitController.Intent] = []
        var replies: [Bool] = []
        var terminations = 0
        let delegate = NativeApplicationDelegate(
            quit: quit,
            terminateApplication: { terminations += 1 },
            replyToTermination: { replies.append($0) }
        )
        delegate.applicationDidFinishLaunching(Notification(name: NSApplication.didFinishLaunchingNotification))
        // Keep the injected warning unanswered so the modal-open window is deterministic.
        quit.onUnavailable = { prompts.append($0) }
        quit.canvasFailed()
        quit.request(.close)
        #expect(prompts == [.close])
        quit.acknowledgeListener()
        #expect(delegate.applicationShouldTerminate(NSApplication.shared) == .terminateCancel)
        #expect(quit.pendingIntent == .close)
        #expect(replies.isEmpty, "未返回 terminateLater 的请求不得调用 reply")
        quit.resolveUnavailable(approved: true)
        #expect(quit.pendingIntent == nil)
        #expect(replies.isEmpty)
        #expect(terminations == 0)
    }

    /// An existing deferred terminate stays paired with the warning's decision while a new request is cancelled.
    @Test func activeWarningRetainsExistingDeferredTermination() {
        let quit = HostQuitController()
        var prompts: [HostQuitController.Intent] = []
        var replies: [Bool] = []
        var terminations = 0
        let delegate = NativeApplicationDelegate(
            quit: quit,
            terminateApplication: { terminations += 1 },
            replyToTermination: { replies.append($0) }
        )
        delegate.applicationDidFinishLaunching(Notification(name: NSApplication.didFinishLaunchingNotification))
        quit.sendEvent = { _, _ in }
        quit.acknowledgeListener()
        #expect(delegate.applicationShouldTerminate(NSApplication.shared) == .terminateLater)
        // The canvas fails while the terminate is deferred; keep the warning unanswered.
        quit.onUnavailable = { prompts.append($0) }
        quit.canvasFailed()
        #expect(prompts == [.terminate])
        #expect(delegate.applicationShouldTerminate(NSApplication.shared) == .terminateCancel)
        #expect(replies.isEmpty)
        quit.resolveUnavailable(approved: true)
        #expect(replies == [true], "已有 terminateLater 的回复必须与警告决定配对")
        #expect(quit.pendingIntent == nil)
        #expect(terminations == 0)
    }
}
