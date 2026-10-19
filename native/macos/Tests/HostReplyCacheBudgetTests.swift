import Foundation
import Testing
@testable import PlotWeaveNative

/// #597: completed reply payloads have a byte budget without granting duplicate side-effect authority.
@MainActor
struct HostReplyCacheBudgetTests {
    /// A large project reply is delivered once; either identity format keeps a digest-only retirement record.
    @Test(arguments: [true, false])
    func largeProjectReplyIsNotRetainedForReplay(ordered: Bool) async throws {
        var executions = 0
        let router = HostCommandRouter { _ in
            executions += 1
            return .object(["project": .object(["name": .string("Fixture"), "script": .string(String(repeating: "p", count: 2 * 1024 * 1024))])])
        }
        let requestId = ordered ? router.sessionId + ":1" : "legacy-large"
        let request = body(router, id: requestId)
        let delivered = await router.handle(request, trustedMainFrame: true)
        #expect(delivered["ok"]?["project"]?["script"]?.string?.utf8.count == 2 * 1024 * 1024)
        #expect(router.cachedReplyBytes == 0)
        let replay = await router.handle(request, trustedMainFrame: true)
        #expect(replay["error"]?["code"]?.string == "PW_HOST_REQUEST_RETIRED")
        var changed = request
        changed["args"] = ["id": "different-project"]
        #expect(await router.handle(changed, trustedMainFrame: true)["error"]?["code"]?.string == "PW_REQUEST_CONFLICT")
        #expect(executions == 1)
    }

    /// Ordinary small responses remain replayable with the same identity and outcome.
    @Test func smallReplyStillSharesItsCompletedResult() async {
        var executions = 0
        let router = HostCommandRouter { _ in executions += 1; return .string("small result") }
        let request = body(router, id: router.sessionId + ":1")
        let first = await router.handle(request, trustedMainFrame: true)
        #expect(await router.handle(request, trustedMainFrame: true) == first)
        #expect(executions == 1)
    }

    /// Exact total/per-item boundaries retain two small replies; a third retires only the oldest payload.
    @Test(arguments: [true, false])
    func aggregateBudgetRetiresPayloadsWithoutReexecution(ordered: Bool) async {
        var executions = 0
        let router = HostCommandRouter(cacheLimits: .init(totalBytes: 58, maximumReplyBytes: 29)) { _ in
            executions += 1
            return .string(String(repeating: "x", count: 20)) // {"ok":"<20 ASCII bytes>"} = 29 UTF-8 bytes.
        }
        let ids = (1...3).map { ordered ? router.sessionId + ":\($0)" : "opaque-\($0)" }
        _ = await router.handle(body(router, id: ids[0]), trustedMainFrame: true)
        #expect(router.cachedReplyBytes == 29)
        let retained = await router.handle(body(router, id: ids[1]), trustedMainFrame: true)
        #expect(router.cachedReplyBytes == 58)
        _ = await router.handle(body(router, id: ids[2]), trustedMainFrame: true)
        #expect(router.cachedReplyBytes == 58)
        #expect(await router.handle(body(router, id: ids[0]), trustedMainFrame: true)["error"]?["code"]?.string == "PW_HOST_REQUEST_RETIRED")
        #expect(await router.handle(body(router, id: ids[1]), trustedMainFrame: true) == retained)
        #expect(executions == 3)
    }

    /// Escapes and multibyte text count as encoded bytes, not characters or unescaped storage length.
    @Test func encodedByteBudgetIncludesEscapesAndUTF8() async {
        let escaped = HostCommandRouter(cacheLimits: .init(totalBytes: 100, maximumReplyBytes: 14)) { _ in
            .string("\"\\\n") // Three characters encode to six payload bytes plus the nine-byte envelope.
        }
        let request = body(escaped, id: "escaped")
        #expect(await escaped.handle(request, trustedMainFrame: true)["ok"]?.string == "\"\\\n")
        #expect(escaped.cachedReplyBytes == 0)
        #expect(await escaped.handle(request, trustedMainFrame: true)["error"]?["code"]?.string == "PW_HOST_REQUEST_RETIRED")
        let unicode = HostCommandRouter(cacheLimits: .init(totalBytes: 12, maximumReplyBytes: 12)) { _ in .string("清") }
        let unicodeRequest = body(unicode, id: "unicode")
        _ = await unicode.handle(unicodeRequest, trustedMainFrame: true)
        #expect(unicode.cachedReplyBytes == 12)
        #expect(await unicode.handle(unicodeRequest, trustedMainFrame: true)["ok"]?.string == "清")
    }

    /// Budget pressure on later replies cannot retire pending work or split an already-joined duplicate.
    @Test func inFlightDuplicatesSurvivePayloadPressure() async throws {
        let gate = Gate()
        defer { gate.release() }
        var executions = 0
        let router = HostCommandRouter(cacheLimits: .init(totalBytes: 58, maximumReplyBytes: 29)) { request in
            executions += 1
            if request.args?["id"]?.string == "held" { await gate.wait(); return .string(String(repeating: "h", count: 64)) }
            return .string(String(repeating: "x", count: 20))
        }
        var pendingBody = body(router, id: router.sessionId + ":1")
        pendingBody["args"] = ["id": "held"]
        let first = Task { await router.handle(pendingBody, trustedMainFrame: true) }
        try await waitUntil { gate.started }
        var duplicateStarted = false
        let duplicate = Task { @MainActor in
            // The same-actor handle has no suspension before joining the registered Task.
            duplicateStarted = true
            return await router.handle(pendingBody, trustedMainFrame: true)
        }
        try await waitUntil { duplicateStarted }
        for ordinal in 2...4 {
            _ = await router.handle(body(router, id: router.sessionId + ":\(ordinal)"), trustedMainFrame: true)
            #expect(router.cachedReplyBytes <= 58)
        }
        gate.release()
        let delivered = await first.value
        #expect(await duplicate.value == delivered)
        #expect(delivered["ok"]?.string?.count == 64)
        #expect(executions == 4)
        #expect(router.cachedReplyBytes == 58)
        #expect(await router.handle(pendingBody, trustedMainFrame: true)["error"]?["code"]?.string == "PW_HOST_REQUEST_RETIRED")
    }

    /// A late old completion cannot recharge a cleared cache or displace a new session's valid result.
    @Test(arguments: [true, false])
    func sessionTransitionClearsBudgetAndRejectsOldCompletion(reload: Bool) async throws {
        let gate = Gate()
        defer { gate.release() }
        let router = HostCommandRouter { request in
            if request.args?["id"]?.string == "held" { await gate.wait() }
            return .string("small")
        }
        _ = await router.handle(body(router, id: router.sessionId + ":1"), trustedMainFrame: true)
        #expect(router.cachedReplyBytes > 0)
        var old = body(router, id: router.sessionId + ":2")
        old["args"] = ["id": "held"]
        let pending = Task { await router.handle(old, trustedMainFrame: true) }
        try await waitUntil { gate.started }
        if reload { router.beginSession() } else { router.invalidate() }
        #expect(router.cachedReplyBytes == 0)
        let current = body(router, id: router.sessionId + ":1")
        let latest = await router.handle(current, trustedMainFrame: true)
        let charge = router.cachedReplyBytes
        gate.release()
        #expect(await pending.value["error"]?["code"]?.string == "PW_STALE_SESSION")
        #expect(router.cachedReplyBytes == charge)
        #expect(await router.handle(current, trustedMainFrame: true) == latest)
        #expect(reload ? latest["ok"]?.string == "small" : latest["error"]?["code"]?.string == "PW_STALE_SESSION")
    }

    /// Cache encoding failure never invents a stored success or reexecutes a completed service.
    @Test func unencodableResultIsNotCachedOrReexecuted() async {
        var executions = 0
        let router = HostCommandRouter { _ in executions += 1; return .number(.infinity) }
        let request = body(router, id: router.sessionId + ":1")
        #expect(await router.handle(request, trustedMainFrame: true)["ok"] == .number(.infinity))
        #expect(router.cachedReplyBytes == 0)
        #expect(await router.handle(request, trustedMainFrame: true)["error"]?["code"]?.string == "PW_HOST_REQUEST_RETIRED")
        #expect(executions == 1)
    }

    /// Explicit scheduling, not a fixed delay, signals that the relevant owner reached its entry point.
    private func waitUntil(_ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while !condition() && ContinuousClock.now < deadline { await Task.yield() }
        try #require(condition())
    }

    /// Holds the single service execution until all required observations are established.
    @MainActor private final class Gate {
        /// Observable service entry for deterministic request interleavings.
        private(set) var started = false
        /// Exactly one accepted service execution owns the suspended continuation.
        private var continuation: CheckedContinuation<Void, Never>?
        /// Test cleanup may release before a cancelled caller enters the gate.
        private var released = false

        /// Waits only until the test authorizes completion.
        func wait() async {
            started = true
            if released { return }
            await withCheckedContinuation { continuation = $0 }
        }

        /// Resumes at most once, including cleanup after a failed expectation.
        func release() {
            released = true
            continuation?.resume()
            continuation = nil
        }
    }

    /// Produces the documented v1 envelope; fixture data never reaches production storage.
    private func body(_ router: HostCommandRouter, id: String) -> [String: Any] {
        ["protocolVersion": 1, "sessionId": router.sessionId, "requestId": id,
         "command": "load_project", "args": ["id": "fixture-project"]]
    }
}
