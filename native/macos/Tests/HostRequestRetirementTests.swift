import Foundation
import Testing
@testable import PlotWeaveNative

/// The production Web request identity must outlive navigation without exhausting real saves or exit.
@MainActor
struct HostRequestRetirementTests {
    /// Retiring completed reads admits a later real save and quit while denying replay of the first read.
    @Test func completedProductionRequestsAllowSaveAndQuit() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-host-retirement-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let quit = HostQuitController()
        quit.sendEvent = { _, _ in }
        var approved = false
        quit.onApproved = { _ in approved = true }
        quit.acknowledgeListener()
        let services = NativeHostServices(dataRoot: root, quit: quit)
        let store = try #require(services.projectStore)
        let created = try await store.invoke(command: "create_project", args: ["name": .string("原稿")])
        let id = try #require(created["id"]?.string)
        var doc = try await store.invoke(command: "load_project", args: ["id": .string(id)])
        doc = try renamedDocument(doc)
        let router = HostCommandRouter(service: services.perform)
        let first = body(router, ordinal: 1, command: "list_projects")
        for ordinal in 1...4096 {
            let reply = await router.handle(body(router, ordinal: ordinal, command: "list_projects"), trustedMainFrame: true)
            try #require(reply["error"] == nil)
        }
        let saved = await router.handle(body(router, ordinal: 4097, command: "save_project", args: ["id": id, "doc": doc.webValue, "expectExisting": true]), trustedMainFrame: true)
        #expect(saved["error"] == nil)
        let loaded = try await store.invoke(command: "load_project", args: ["id": .string(id)])
        #expect(loaded["project"]?["name"]?.string == "最后编辑")
        quit.request(.terminate)
        let exit = await router.handle(body(router, ordinal: 4098, command: "app_exit"), trustedMainFrame: true)
        #expect(exit["error"] == nil)
        #expect(approved)
        let replay = await router.handle(first, trustedMainFrame: true)
        #expect(replay["error"]?["code"]?.string == "PW_HOST_REQUEST_RETIRED")
        await services.close()
    }

    /// An old unfinished create remains deduplicated even after later reads advance the retirement watermark.
    @Test func inFlightOldIdentitySurvivesOutOfOrderRetirement() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-host-retirement-pending-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let services = NativeHostServices(dataRoot: root, quit: HostQuitController())
        let gate = EntryGate()
        defer { gate.release() }
        let router = HostCommandRouter { request in
            if request.command == "create_project" { await gate.wait() }
            return try await services.perform(request)
        }
        let create = body(router, ordinal: 1, command: "create_project", args: ["name": "只创建一次"])
        let first = Task { await router.handle(create, trustedMainFrame: true) }
        try await awaitEntries(gate, count: 1)
        for ordinal in 2...4097 {
            let reply = await router.handle(body(router, ordinal: ordinal, command: "list_projects"), trustedMainFrame: true)
            try #require(reply["error"] == nil)
        }
        let duplicate = Task { await router.handle(create, trustedMainFrame: true) }
        let changed = await router.handle(body(router, ordinal: 4097, command: "create_project", args: ["name": "冲突"]), trustedMainFrame: true)
        #expect(changed["error"]?["code"]?.string == "PW_REQUEST_CONFLICT")
        gate.release()
        let reply = await first.value
        #expect(await duplicate.value == reply)
        let store = try #require(services.projectStore)
        #expect(try await store.invoke(command: "list_projects", args: [:]).arrayValue?.count == 1)
        let retired = await router.handle(body(router, ordinal: 2, command: "list_projects"), trustedMainFrame: true)
        #expect(retired["error"]?["code"]?.string == "PW_HOST_REQUEST_RETIRED")
        let old = body(router, ordinal: 4098, command: "create_project", args: ["name": "旧页"])
        router.beginSession()
        #expect(await router.handle(old, trustedMainFrame: true)["error"]?["code"]?.string == "PW_STALE_SESSION")
        #expect(await router.handle(body(router, ordinal: 1, command: "list_projects"), trustedMainFrame: true)["error"] == nil)
        await services.close()
    }

    /// Full in-flight work cannot be evicted; completing it permits a fresh identity without rerunning old effects.
    @Test func allInFlightOrderedRequestsRejectThenRecover() async throws {
        let gate = EntryGate()
        defer { gate.release() }
        var executions = 0
        let router = HostCommandRouter { _ in
            await gate.wait()
            try Task.checkCancellation()
            executions += 1
            return .number(Double(executions))
        }
        let pending = (1...4096).map { ordinal in
            let value = body(router, ordinal: ordinal, command: "write")
            return Task { await router.handle(value, trustedMainFrame: true) }
        }
        try await awaitEntries(gate, count: 4096)
        let overflow = body(router, ordinal: 4097, command: "write")
        #expect(await router.handle(overflow, trustedMainFrame: true)["error"]?["code"]?.string == "PW_REQUEST_CAPACITY")
        #expect(executions == 0)
        gate.release()
        for task in pending { #expect(await task.value["error"] == nil) }
        #expect(await router.handle(overflow, trustedMainFrame: true)["error"] == nil)
        #expect(executions == 4097)
    }

    /// Noncanonical or unsafe production ordinals cannot acquire write authority or alias an existing identity.
    @Test func invalidOrderedIdentityCannotPerformSideEffects() async {
        var executions = 0
        let router = HostCommandRouter { _ in executions += 1; return .null }
        for suffix in ["0", "-1", "01", "1.0", "9007199254740992"] {
            var value = body(router, ordinal: 1, command: "write")
            value["requestId"] = router.sessionId + ":" + suffix
            #expect(await router.handle(value, trustedMainFrame: true)["error"]?["code"]?.string == "PW_INVALID_REQUEST")
        }
        #expect(executions == 0)
        #expect(await router.handle(body(router, ordinal: 9_007_199_254_740_991, command: "write"), trustedMainFrame: true)["error"] == nil)
        #expect(executions == 1)
    }

    /// Observes actual storage entry without guessing how long main-actor scheduling takes.
    private func awaitEntries(_ gate: EntryGate, count: Int) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while gate.started < count && ContinuousClock.now < deadline { await Task.yield() }
        try #require(gate.started == count)
    }

    /// Test scheduling holds service entry; cancellation and actual side effects stay owned by the production caller.
    @MainActor private final class EntryGate {
        var started = 0
        private var released = false
        private var continuations: [CheckedContinuation<Void, Never>] = []

        /// Late arrivals after cleanup never remain suspended.
        func wait() async {
            started += 1
            if released { return }
            await withCheckedContinuation { continuations.append($0) }
        }

        /// One explicit release resumes every registered service entry exactly once.
        func release() {
            released = true
            let waiting = continuations
            continuations.removeAll()
            waiting.forEach { $0.resume() }
        }
    }

    /// Changes the real persisted document through its decoded semantic representation.
    private func renamedDocument(_ doc: HostJSON) throws -> HostJSON {
        var value = try #require(doc.object)
        var project = try #require(value["project"]?.object)
        project["name"] = .string("最后编辑")
        value["project"] = .object(project)
        return .object(value)
    }

    /// Matches invokeSwiftHost's existing production identity without consulting the router's implementation.
    private func body(_ router: HostCommandRouter, ordinal: Int, command: String, args: [String: Any] = [:]) -> [String: Any] {
        ["protocolVersion": 1, "sessionId": router.sessionId, "requestId": "\(router.sessionId):\(ordinal)", "command": command, "args": args]
    }
}
