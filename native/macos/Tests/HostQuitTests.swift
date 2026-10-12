import Testing
@testable import PlotWeaveNative

/// One lifecycle state owns all normal user exit entries, startup buffering and flush approval.
@MainActor
struct HostQuitTests {
    /// Startup exit cannot be approved before the current page installs its flush listener.
    @Test func bufferedExitCannotSkipListenerHandshake() {
        let quit = HostQuitController()
        quit.request(.close)
        #expect(throws: HostFailure.self) { try quit.approve() }
        #expect(quit.pendingIntent == .close)
    }

    /// Listener acknowledgement releases the buffered user intent once and approval consumes it.
    @Test func acknowledgementDeliversBufferedQuit() async throws {
        let quit = HostQuitController()
        var names: [String] = []
        var approved: [HostQuitController.Intent] = []
        quit.sendEvent = { name, _ in names.append(name) }
        quit.onApproved = { approved.append($0) }
        quit.request(.close)
        #expect(names == [])
        quit.acknowledgeListener()
        await Task.yield()
        #expect(names == ["app-quit-requested"])
        try quit.approve()
        #expect(approved == [.close])
        #expect(quit.pendingIntent == nil)
        #expect(throws: HostFailure.self) { try quit.approve() }
    }

    /// An application quit supersedes a buffered window close without discarding its flush requirement.
    @Test func dockOrCommandQuitSupersedesClose() throws {
        let quit = HostQuitController()
        var result: HostQuitController.Intent?
        quit.onApproved = { result = $0 }
        quit.request(.close)
        quit.request(.terminate)
        quit.request(.close)
        quit.acknowledgeListener()
        try quit.approve()
        #expect(result == .terminate)
    }

    /// Replacing a ready page cancels its pending quit; previous approval authority does not carry over.
    @Test func reconnectCancelsIntentAndRemovesOldListenerAuthority() {
        let quit = HostQuitController()
        quit.acknowledgeListener()
        quit.request(.terminate)
        quit.resetListener()
        #expect(throws: HostFailure.self) { try quit.approve() }
        #expect(quit.pendingIntent == nil)
    }
}
