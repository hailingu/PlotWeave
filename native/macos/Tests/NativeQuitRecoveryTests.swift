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

    /// Delivery failure cannot strand the app in AppKit's modal quit loop; the next user request can retry.
    @Test func bridgeDeliveryFailureRetainsAnInteractiveRetry() async throws {
        let quit = HostQuitController()
        var delivered = 0
        var terminations = 0
        quit.sendEvent = { _, _ in
            delivered += 1
            throw HostFailure(code: "PW_PAGE_UNAVAILABLE", message: "fixture delivery failure")
        }
        let delegate = NativeApplicationDelegate(quit: quit, terminateApplication: { terminations += 1 })
        delegate.applicationDidFinishLaunching(Notification(name: NSApplication.didFinishLaunchingNotification))
        quit.acknowledgeListener()
        #expect(delegate.applicationShouldTerminate(NSApplication.shared) == .terminateCancel)
        await Task.yield()
        #expect(delivered == 1)
        #expect(quit.pendingIntent == .terminate)
        #expect(terminations == 0)
        quit.sendEvent = { _, _ in delivered += 1 }
        #expect(delegate.applicationShouldTerminate(NSApplication.shared) == .terminateCancel)
        await Task.yield()
        #expect(delivered == 2)
        try quit.approve()
        #expect(terminations == 1)
        #expect(delegate.applicationShouldTerminate(NSApplication.shared) == .terminateNow)
    }
}
