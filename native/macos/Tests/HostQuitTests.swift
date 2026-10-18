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

    /// A failed canvas cannot silently buffer close/quit: the pending intent gets one visible degraded decision.
    @Test func canvasFailurePromptsAndApprovedDegradeConsumesIntent() {
        let quit = HostQuitController()
        var prompts: [HostQuitController.Intent] = []
        var approved: [HostQuitController.Intent] = []
        quit.onUnavailable = { prompts.append($0) }
        quit.onApproved = { approved.append($0) }
        quit.canvasFailed()
        quit.request(.close)
        #expect(prompts == [.close])
        #expect(quit.pendingIntent == .close)
        #expect(quit.canvasUnavailable)
        quit.resolveUnavailable(approved: true)
        #expect(approved == [.close])
        #expect(quit.pendingIntent == nil)
    }

    /// A close buffered before the failure is preserved and surfaced once the canvas becomes unavailable.
    @Test func bufferedIntentGetsPromptWhenCanvasFails() {
        let quit = HostQuitController()
        var prompts: [HostQuitController.Intent] = []
        var approved: [HostQuitController.Intent] = []
        quit.onUnavailable = { prompts.append($0) }
        quit.onApproved = { approved.append($0) }
        quit.request(.terminate)
        #expect(prompts.isEmpty)
        quit.canvasFailed()
        #expect(prompts == [.terminate])
        #expect(quit.pendingIntent == .terminate)
        quit.resolveUnavailable(approved: false)
        #expect(approved.isEmpty)
        #expect(quit.pendingIntent == nil)
        #expect(quit.canvasUnavailable, "取消降级退出不表示画布已恢复")
    }

    /// One visible decision at a time: later requests do not stack alerts and cancellation allows an explicit retry.
    @Test func degradedPromptDoesNotStackAndCancellationAllowsRetry() {
        let quit = HostQuitController()
        var prompts: [HostQuitController.Intent] = []
        var approved: [HostQuitController.Intent] = []
        quit.onUnavailable = { prompts.append($0) }
        quit.onApproved = { approved.append($0) }
        quit.canvasFailed()
        quit.request(.close)
        quit.request(.terminate)
        #expect(prompts == [.close])
        quit.resolveUnavailable(approved: false)
        #expect(quit.pendingIntent == nil)
        quit.request(.terminate)
        #expect(prompts == [.close, .terminate])
        quit.resolveUnavailable(approved: true)
        #expect(approved == [.terminate])
    }

    /// A reconnected page's acknowledgement restores normal listener authority and clears the degraded flag.
    @Test func acknowledgementClearsCanvasFailure() async {
        let quit = HostQuitController()
        var prompts: [HostQuitController.Intent] = []
        var names: [String] = []
        quit.onUnavailable = { prompts.append($0) }
        quit.canvasFailed()
        quit.acknowledgeListener()
        quit.sendEvent = { name, _ in names.append(name) }
        quit.request(.close)
        await Task.yield()
        #expect(names == ["app-quit-requested"])
        #expect(prompts.isEmpty)
        #expect(!quit.canvasUnavailable)
    }

    /// Delivery failure cancels this attempt with a visible diagnostic but preserves listener authority for a retry.
    @Test func deliveryFailureCancelsVisiblyAndKeepsListenerAuthority() async throws {
        let quit = HostQuitController()
        var failures: [String] = []
        var approved: [HostQuitController.Intent] = []
        quit.sendEvent = { _, _ in
            throw HostFailure(code: "PW_PAGE_UNAVAILABLE", message: "fixture delivery failure")
        }
        quit.onDeliveryFailure = { _, error in failures.append(error.localizedDescription) }
        quit.onApproved = { approved.append($0) }
        quit.acknowledgeListener()
        quit.request(.terminate)
        try await Task.sleep(for: .milliseconds(50))
        #expect(failures == ["fixture delivery failure"])
        #expect(quit.pendingIntent == nil)
        #expect(quit.listenerReady, "投递失败不等于画布失效，重试仍应走正常 listener 路径")
        #expect(!quit.canvasUnavailable)
        #expect(approved.isEmpty)
    }
}
