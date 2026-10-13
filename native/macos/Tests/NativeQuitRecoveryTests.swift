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

    /// Native delivery failure completes the deferred decision even when Web cannot issue its failure command.
    @Test func bridgeDeliveryFailureRetainsAnInteractiveRetry() async throws {
        let quit = HostQuitController()
        var replies: [Bool] = []
        var delivered: CheckedContinuation<Void, Never>?
        quit.sendEvent = { _, _ in
            delivered?.resume()
            delivered = nil
            throw HostFailure(code: "PW_PAGE_UNAVAILABLE", message: "fixture delivery failure")
        }
        let delegate = NativeApplicationDelegate(quit: quit, terminateApplication: {}, replyToTermination: { replies.append($0) })
        delegate.applicationDidFinishLaunching(Notification(name: NSApplication.didFinishLaunchingNotification))
        quit.acknowledgeListener()
        await withCheckedContinuation { continuation in
            delivered = continuation
            #expect(delegate.applicationShouldTerminate(NSApplication.shared) == .terminateLater)
        }
        #expect(replies == [false])
        #expect(quit.pendingIntent == nil)
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
}
