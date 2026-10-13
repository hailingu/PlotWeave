import CryptoKit
import Foundation

/// Versioned native request envelope; IDs bind side effects to one loaded Web session.
struct HostRequest: Decodable, Sendable {
    let protocolVersion: Int
    let sessionId: String
    let requestId: String
    let command: String
    let args: [String: HostJSON]?
}

/// Owns request deduplication and session invalidation on the WebKit actor.
@MainActor
final class HostCommandRouter {
    /// Service adapter performs real work; the router does not own document state.
    typealias Service = @MainActor (HostRequest) async throws -> HostJSON

    /// One UUID identifies each navigation, including a retry of the same entry page.
    private(set) var sessionId = UUID().uuidString
    /// A crashed or unloaded page cannot continue issuing business writes.
    private var active = true
    /// In-flight tasks and completed replies share the same request identity cache.
    private var requests: [String: RequestEntry] = [:]
    /// Recent results and in-flight work share a bound; retired ordered identities cannot execute again.
    private static let capacity = 4096
    /// Retired production ordinals have no authority even when their result is no longer retained.
    private var retiredThrough = 0
    /// Key material appears only while executing a request; the identity cache stores its cryptographic digest.
    private struct RequestEntry {
        let fingerprint: Data
        let task: Task<HostJSON, Never>
        let ordinal: Int?
        var settled = false
    }
    /// Coordinators apply the same invalidation boundary to native intents and read projections.
    var isActive: Bool { active }
    /// Requests retain their owner until completion; none are replayed after a timeout.
    private let service: Service

    init(service: @escaping Service = { request in
        try await NativeHostServices.shared.perform(request)
    }) {
        self.service = service
    }

    /// Invalidates old replies and starts a fresh session before document-start injection.
    func beginSession() {
        cancelRequests()
        active = true
        sessionId = UUID().uuidString
    }

    /// Stops new operations and cancels pending work; effects already committed still have unknown outcomes.
    func invalidate() {
        active = false
        cancelRequests()
    }

    /// Cancellation revokes work before dropping identity records; no side effect is retried or rolled back.
    private func cancelRequests() {
        for request in requests.values { request.task.cancel() }
        requests.removeAll()
        retiredThrough = 0
    }

    /// Validates trust, protocol and identity before sharing a single execution per request ID.
    func handle(_ body: Any, trustedMainFrame: Bool) async -> HostJSON {
        guard trustedMainFrame else {
            return failure("PW_UNTRUSTED_FRAME", "拒绝来自非受信主页面的宿主请求")
        }
        let request: HostRequest
        do {
            let data = try JSONSerialization.data(withJSONObject: body)
            request = try JSONDecoder().decode(HostRequest.self, from: data)
        } catch {
            return failure("PW_INVALID_REQUEST", "宿主请求不是有效协议对象")
        }
        guard request.protocolVersion == 1, !request.requestId.isEmpty,
              !request.command.isEmpty else {
            return failure("PW_INVALID_REQUEST", "宿主请求版本或身份无效")
        }
        guard active, request.sessionId == sessionId else {
            return failure("PW_STALE_SESSION", "页面会话已失效，本次结果未知")
        }
        let fingerprint: Data
        do { fingerprint = try Self.fingerprint(request) }
        catch { return failure("PW_INVALID_REQUEST", "宿主请求参数不能规范编码") }
        let task: Task<HostJSON, Never>
        if let existing = requests[request.requestId] {
            guard existing.fingerprint == fingerprint else {
                return failure("PW_REQUEST_CONFLICT", "相同请求身份不能更改命令或参数")
            }
            task = existing.task
        } else {
            let ordinal: Int?
            do { ordinal = try requestOrdinal(request.requestId) }
            catch { return failure("PW_INVALID_REQUEST", "宿主请求身份不是有效安全序号") }
            if let ordinal, ordinal <= retiredThrough {
                return failure("PW_HOST_REQUEST_RETIRED", "该宿主请求已退役，不能重复执行；请核对结果。")
            }
            guard admitRequest() else {
                return failure("PW_REQUEST_CAPACITY", "当前页面请求仍占满身份窗口，请等待完成后明确重试。")
            }
            task = start(request, fingerprint: fingerprint, ordinal: ordinal)
        }
        let reply = await task.value
        guard active, request.sessionId == sessionId else {
            return failure("PW_STALE_SESSION", "页面会话已失效，本次结果未知")
        }
        return reply
    }

    /// Registers work before yielding, so duplicate in-flight deliveries cannot run twice.
    private func start(_ request: HostRequest, fingerprint: Data, ordinal: Int?) -> Task<HostJSON, Never> {
        let service = service
        let task = Task { @MainActor [weak self] in
            defer { self?.markSettled(request) }
            do {
                try Task.checkCancellation()
                return HostJSON.object(["ok": try await service(request)])
            }
            catch let error as HostFailure { return error.reply }
            catch { return HostFailure(code: "PW_HOST_ERROR", message: error.localizedDescription).reply }
        }
        requests[request.requestId] = RequestEntry(fingerprint: fingerprint, task: task, ordinal: ordinal)
        return task
    }

    /// Current production IDs are canonical session-prefixed safe integers; legacy opaque IDs remain bounded.
    private func requestOrdinal(_ id: String) throws -> Int? {
        let prefix = sessionId + ":"
        guard id.hasPrefix(prefix) else { return nil }
        let suffix = String(id.dropFirst(prefix.count))
        guard let ordinal = Int(suffix), ordinal > 0, ordinal <= 9_007_199_254_740_991,
              suffix == String(ordinal) else {
            throw HostFailure(code: "PW_INVALID_REQUEST", message: "宿主请求序号无效")
        }
        return ordinal
    }

    /// Capacity pressure retires the oldest completed ordered identity, never an in-flight or opaque entry.
    private func admitRequest() -> Bool {
        if requests.count < Self.capacity { return true }
        let candidate = requests.filter { $0.value.settled && $0.value.ordinal != nil }
            .min { ($0.value.ordinal ?? Int.max) < ($1.value.ordinal ?? Int.max) }
        guard let candidate, let ordinal = candidate.value.ordinal else { return false }
        requests.removeValue(forKey: candidate.key)
        retiredThrough = max(retiredThrough, ordinal)
        return true
    }

    /// Old-page completion cannot settle a newer session's identity after cancellation or replacement.
    private func markSettled(_ request: HostRequest) {
        guard request.sessionId == sessionId else { return }
        requests[request.requestId]?.settled = true
    }

    /// Canonical command/args hashing recognizes reordered JSON keys without retaining plaintext secrets.
    private static func fingerprint(_ request: HostRequest) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let payload = HostJSON.object(["command": .string(request.command), "args": .object(request.args ?? [:])])
        return Data(SHA256.hash(data: try encoder.encode(payload)))
    }

    /// Builds a stable diagnostic without exposing internal callback or file handles.
    private func failure(_ code: String, _ message: String) -> HostJSON {
        HostFailure(code: code, message: message).reply
    }
}
