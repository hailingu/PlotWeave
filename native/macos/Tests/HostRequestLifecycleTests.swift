import Foundation
import Testing
@testable import PlotWeaveNative

/// Page lifecycle cancellation prevents old queued host requests from beginning a new real storage side effect.
@MainActor
struct HostRequestLifecycleTests {
    /// Dismantle/crash rejects the reply and cancels work that has not yet entered the storage actor.
    @Test func invalidationCancelsPendingSideEffect() async throws { try await verifyCancelled(reload: false) }
    /// Reload creates a new authority and cancels the preceding page's delayed work before it persists.
    @Test func newSessionCancelsPendingSideEffect() async throws { try await verifyCancelled(reload: true) }

    /// Real files witness the invariant; injected scheduling isolates only the time before native storage begins.
    private func verifyCancelled(reload: Bool) async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-host-lifecycle-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let services = NativeHostServices(dataRoot: root, quit: HostQuitController())
        let started = Started()
        let barrier = StorageEntryBarrier()
        defer { barrier.release() }
        let router = HostCommandRouter { request in
            started.value = true
            await barrier.wait()
            try Task.checkCancellation()
            return try await services.perform(request)
        }
        let body: [String: Any] = ["protocolVersion": 1, "sessionId": router.sessionId, "requestId": "delayed-create", "command": "create_project", "args": ["name": "不应创建"]]
        let pending = Task { await router.handle(body, trustedMainFrame: true) }
        let deadline = ContinuousClock.now.advanced(by: .seconds(2))
        while !started.value && ContinuousClock.now < deadline { await Task.yield() }
        try #require(started.value)
        if reload { router.beginSession() } else { router.invalidate() }
        barrier.release()
        let reply = await pending.value
        #expect(reply["error"]?["code"]?.string == "PW_STALE_SESSION")
        let projects = try #require(services.projectStore)
        #expect(try await projects.invoke(command: "list_projects", args: [:]) == .array([]))
        await services.close()
    }

    /// A deterministic injected queue holds storage entry until the test has ended page authority.
    @MainActor private final class StorageEntryBarrier {
        private var continuation: CheckedContinuation<Void, Never>?

        /// Waiting contains no filesystem action and deliberately leaves cancellation for the caller to observe.
        func wait() async {
            await withCheckedContinuation { continuation = $0 }
        }

        /// Releases at most once after the tested session transition rather than relying on a wall-clock delay.
        func release() {
            continuation?.resume()
            continuation = nil
        }
    }

    /// Main-actor scheduling state contains no request data or credential content.
    private final class Started { var value = false }
}
