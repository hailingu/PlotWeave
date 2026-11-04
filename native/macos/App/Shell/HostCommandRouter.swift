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
    /// In-flight authority and completed reply retention have separate lifetimes.
    private var requests: [String: RequestEntry] = [:]
    /// Identity metadata remains bounded even after payload eviction.
    private static let capacity = 4096
    /// Retired production ordinals have no authority even when their identity is no longer retained.
    private var retiredThrough = 0
    /// Encoded JSON bytes retained by completed replies; excludes in-flight work and identity metadata.
    private(set) var cachedReplyBytes = 0
    /// Completion order provides payload age without an independently growing queue.
    private var completionOrder = 0
    /// Retention policy is internal, not a new user preference or wire field.
    struct ReplyCacheLimits {
        /// Maximum combined encoded bytes of completed replies.
        let totalBytes: Int
        /// A single large response is delivered but never retained as a cached payload.
        let maximumReplyBytes: Int
        /// A long-lived page keeps at most 8 MiB of completed JSON, with a 1 MiB per-reply ceiling.
        static let standard = ReplyCacheLimits(totalBytes: 8 * 1024 * 1024, maximumReplyBytes: 1024 * 1024)
    }
    /// Mutually exclusive states prevent completed Task results from bypassing the payload budget.
    private enum RequestState {
        case pending(Task<HostJSON, Never>)
        case completed(HostJSON, bytes: Int, order: Int)
        case retired

        /// Only unfinished work can be awaited or cancelled through the identity record.
        var task: Task<HostJSON, Never>? {
            if case .pending(let task) = self { return task }
            return nil
        }
        /// Completed payload charge, or zero for work/identity-only states.
        var bytes: Int {
            if case .completed(_, let bytes, _) = self { return bytes }
            return 0
        }
        /// Payload age is absent for pending work and retired digests.
        var order: Int? {
            if case .completed(_, _, let order) = self { return order }
            return nil
        }
    }
    /// Command/argument identity metadata retains its digest, not the original request payload.
    private struct RequestEntry {
        let fingerprint: Data
        let ordinal: Int?
        var state: RequestState
    }
    /// Nonnegative limits bound completed payloads; zero deliberately disables result retention.
    private let cacheLimits: ReplyCacheLimits
    /// Coordinators apply the same invalidation boundary to native intents and read projections.
    var isActive: Bool { active }
    /// Requests retain their owner until completion; none are replayed after a timeout.
    private let service: Service

    /// Configures bounded completed-result retention while keeping the existing service adapter.
    init(cacheLimits: ReplyCacheLimits = .standard, service: @escaping Service = { request in
        try await NativeHostServices.shared.perform(request)
    }) {
        self.service = service
        self.cacheLimits = ReplyCacheLimits(
            totalBytes: max(0, cacheLimits.totalBytes), maximumReplyBytes: max(0, cacheLimits.maximumReplyBytes)
        )
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
        for request in requests.values { request.state.task?.cancel() }
        requests.removeAll()
        cachedReplyBytes = 0
        completionOrder = 0
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
            try HostJSON.rejectNestingBeyondLimit(data)
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
            switch existing.state {
            case .pending(let pending): task = pending
            case .completed(let reply, _, _): return reply
            case .retired:
                return failure("PW_HOST_REQUEST_RETIRED", "该宿主请求已完成，结果已退役；请核对结果，不要自动重放。")
            }
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

    /// Registers work before yielding; completion drops the Task from the router before retaining any payload.
    private func start(_ request: HostRequest, fingerprint: Data, ordinal: Int?) -> Task<HostJSON, Never> {
        let service = service
        let task = Task { @MainActor [weak self] in
            let reply: HostJSON
            do {
                try Task.checkCancellation()
                reply = HostJSON.object(["ok": try await service(request)])
            }
            catch let error as HostFailure { reply = error.reply }
            catch { reply = HostFailure(code: "PW_HOST_ERROR", message: error.localizedDescription).reply }
            self?.settle(request, reply: reply)
            return reply
        }
        requests[request.requestId] = RequestEntry(fingerprint: fingerprint, ordinal: ordinal, state: .pending(task))
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
        let candidate = requests.filter { $0.value.state.task == nil && $0.value.ordinal != nil }
            .min { ($0.value.ordinal ?? Int.max) < ($1.value.ordinal ?? Int.max) }
        guard let candidate, let ordinal = candidate.value.ordinal else { return false }
        cachedReplyBytes -= candidate.value.state.bytes
        requests.removeValue(forKey: candidate.key)
        retiredThrough = max(retiredThrough, ordinal)
        return true
    }

    /// Old-page completions cannot populate a new cache; every completed Task becomes a digest or bounded reply.
    private func settle(_ request: HostRequest, reply: HostJSON) {
        guard active, request.sessionId == sessionId,
              var entry = requests[request.requestId], entry.state.task != nil else { return }
        entry.state = .retired
        requests[request.requestId] = entry
        let bytes: Int
        do { bytes = try JSONEncoder().encode(reply).count }
        catch { return } // An unencodable outcome cannot acquire a cache charge; its original result still belongs to this caller.
        guard bytes <= cacheLimits.maximumReplyBytes, bytes <= cacheLimits.totalBytes,
              makeRoom(for: bytes) else { return }
        completionOrder += 1
        entry.state = .completed(reply, bytes: bytes, order: completionOrder)
        requests[request.requestId] = entry
        cachedReplyBytes += bytes
    }

    /// Retires oldest completed payloads before admission; pending tasks and their waiters are untouched.
    private func makeRoom(for bytes: Int) -> Bool {
        while cachedReplyBytes > cacheLimits.totalBytes - bytes {
            let candidate = requests.filter { $0.value.state.order != nil }
                .min { ($0.value.state.order ?? Int.max) < ($1.value.state.order ?? Int.max) }
            guard let candidate else { return false }
            var entry = candidate.value
            cachedReplyBytes -= entry.state.bytes
            entry.state = .retired
            requests[candidate.key] = entry
        }
        return true
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
