import Foundation
import Testing
@testable import PlotWeaveNative

/// Real host operations prove routing, deduplication and stale-session rejection.
@MainActor
struct HostCommandRouterTests {
    /// A duplicate delivered in flight and again after completion creates exactly one persisted project.
    @Test func duplicateCreatePersistsOnlyOnce() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-swift-host-" + UUID().uuidString)
        let services = NativeHostServices(dataRoot: root, quit: HostQuitController())
        let router = HostCommandRouter(service: services.perform)
        let name = "Bridge \(UUID().uuidString)"
        let body = request(router, id: "create-once", command: "create_project", args: ["name": name])
        let first = Task { @MainActor in await router.handle(body, trustedMainFrame: true) }
        let duplicate = Task { @MainActor in await router.handle(body, trustedMainFrame: true) }
        let (a, b) = (await first.value, await duplicate.value)
        #expect(a["error"] == nil)
        #expect(a == b)
        #expect(await router.handle(body, trustedMainFrame: true) == a)
        let changedArgs = await router.handle(request(router, id: "create-once", command: "create_project", args: ["name": "conflicting"]), trustedMainFrame: true)
        #expect(changedArgs["error"]?["code"]?.string == "PW_REQUEST_CONFLICT")
        let changedCommand = await router.handle(request(router, id: "create-once", command: "list_projects"), trustedMainFrame: true)
        #expect(changedCommand["error"]?["code"]?.string == "PW_REQUEST_CONFLICT")
        let listed = await router.handle(request(router, id: "list", command: "list_projects"), trustedMainFrame: true)
        guard case .array(let projects) = listed["ok"] else {
            Issue.record("list_projects did not return a successful array")
            await services.close()
            try? FileManager.default.removeItem(at: root)
            return
        }
        #expect(projects.filter { $0["name"]?.string == name }.count == 1)
        if let id = a["ok"]?["id"]?.string {
            let removed = await router.handle(request(router, id: "delete", command: "delete_project", args: ["id": id]), trustedMainFrame: true)
            #expect(removed == .object(["ok": .null]))
        }
        await services.close()
        try FileManager.default.removeItem(at: root)
    }

    /// Neither an old session nor a non-main trusted page may create a project.
    @Test func invalidSessionAndFrameRejectBeforeStorage() async {
        let router = HostCommandRouter()
        let body = request(router, id: "stale", command: "create_project", args: ["name": "rejected"])
        router.beginSession()
        let stale = await router.handle(body, trustedMainFrame: true)
        #expect(stale["error"]?["code"]?.string == "PW_STALE_SESSION")
        let frame = await router.handle(request(router, id: "frame", command: "create_project", args: ["name": "rejected"]), trustedMainFrame: false)
        #expect(frame["error"]?["code"]?.string == "PW_UNTRUSTED_FRAME")
    }

    /// Crash invalidation refuses subsequent mutations without pretending to save an empty document.
    @Test func invalidatedPageCannotKeepWriting() async {
        let router = HostCommandRouter()
        let body = request(router, id: "after-crash", command: "create_project", args: ["name": "rejected"])
        router.invalidate()
        let result = await router.handle(body, trustedMainFrame: true)
        #expect(result["error"]?["code"]?.string == "PW_STALE_SESSION")
    }

    /// A valid listener acknowledgement is a Swift lifecycle operation, not a missing Rust command.
    @Test func acknowledgesQuitListenerInSwift() async {
        let services = NativeHostServices(dataRoot: nil, quit: HostQuitController())
        let router = HostCommandRouter(service: services.perform)
        let result = await router.handle(request(router, id: "ack", command: "acknowledge_quit_listener"), trustedMainFrame: true)
        #expect(result == .object(["ok": .null]))
    }


    /// A full identity cache keeps old replies and refuses new side effects rather than replaying evicted work.
    @Test func capacityRejectsNewIdentityWithoutEvictingCompletedRequest() async {
        var executions = 0
        let router = HostCommandRouter(service: { _ in
            executions += 1
            return .number(Double(executions))
        })
        let first = await router.handle(request(router, id: "0", command: "write"), trustedMainFrame: true)
        for index in 1..<4096 {
            _ = await router.handle(request(router, id: String(index), command: "write"), trustedMainFrame: true)
        }
        let overflow = await router.handle(request(router, id: "overflow", command: "write"), trustedMainFrame: true)
        #expect(overflow["error"]?["code"]?.string == "PW_REQUEST_CAPACITY")
        #expect(await router.handle(request(router, id: "0", command: "write"), trustedMainFrame: true) == first)
        #expect(executions == 4096)
        router.beginSession()
        let nextPage = await router.handle(request(router, id: "overflow", command: "write"), trustedMainFrame: true)
        #expect(nextPage["ok"] == .number(4097))
    }

    /// The shared nesting limit precedes service execution and request identity admission (issue #863).
    @Test func nestingBoundaryRejectsBeforeServiceAndKeepsIdentityReusable() async {
        var executions = 0
        let router = HostCommandRouter(service: { _ in
            executions += 1
            return .number(Double(executions))
        })
        // Envelope root and args consume two levels; the nested arrays consume the rest.
        for depth in [33, 64, 200] {
            let result = await router.handle(request(router, id: "depth-\(depth)", command: "write",
                args: ["value": nestedArrays(depth - 2)]), trustedMainFrame: true)
            #expect(result["error"]?["code"]?.string == "PW_INVALID_REQUEST")
            #expect(executions == 0)
        }
        let accepted = await router.handle(request(router, id: "depth-33", command: "write",
            args: ["value": nestedArrays(30)]), trustedMainFrame: true)
        #expect(accepted["ok"] == .number(1))
        let quoted = await router.handle(request(router, id: "quoted", command: "write",
            args: ["value": String(repeating: "[\\\"{", count: 100)]), trustedMainFrame: true)
        #expect(quoted["ok"] == .number(2))
        #expect(executions == 2)
    }

    /// Builds the untyped WebKit input iteratively so the fixture itself never recursively decodes JSON.
    private func nestedArrays(_ levels: Int) -> Any {
        var value: Any = "leaf"
        for _ in 0..<levels { value = [value] }
        return value
    }

    /// Produces protocol fixtures directly from independently known field values.
    private func request(_ router: HostCommandRouter, id: String, command: String, args: [String: Any] = [:]) -> [String: Any] {
        ["protocolVersion": 1, "sessionId": router.sessionId, "requestId": id, "command": command, "args": args]
    }
}
