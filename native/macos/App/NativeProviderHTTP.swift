import Foundation
import Synchronization

/// URLSession provider transport validates the endpoint and every redirect before credentials are sent.
struct NativeProviderHTTP: Sendable {
    /// Fresh configurations permit isolated URLProtocol fixtures without retaining browser credentials/caches.
    let configuration: @Sendable () -> URLSessionConfiguration
    /// Production defaults are ephemeral; tests replace only the URL-loading protocol implementation.
    init(configuration: @escaping @Sendable () -> URLSessionConfiguration = { .ephemeral }) { self.configuration = configuration }

    /// Redirect authority is checked before following, with bearer removal on host/effective-port changes.
    static func redirected(_ request: URLRequest, previous: URL, secureSeen: Bool) throws -> URLRequest {
        guard let url = request.url else { throw NativeNetworkPolicy.refused("服务重定向缺少地址") }
        try NativeNetworkPolicy.provider(url, secureSeen: secureSeen)
        var next = request
        if !NativeNetworkPolicy.sameOrigin(previous, url) { next.setValue(nil, forHTTPHeaderField: "Authorization") }
        return next
    }

    /// The whole nonstreaming POST, redirected headers and chunk-collected body consume one monotonic budget.
    func post(_ input: NativeProviderRequest) async throws -> NativeHTTPReply {
        try NativeNetworkPolicy.provider(input.url)
        guard !input.key.contains("\r"), !input.key.contains("\n"), input.maximum >= 0 else {
            throw HostFailure(code: "PW_KEY_ERROR", message: "API key 或响应限额无效")
        }
        let transfer = NativeProviderTransfer(initial: input.url, maximum: input.maximum)
        let config = configuration()
        config.httpShouldSetCookies = false
        config.httpCookieStorage = nil
        config.urlCredentialStorage = nil
        config.urlCache = nil
        let remaining = ContinuousClock.now.duration(to: input.deadline).components
        let timeout = max(0.001, min(300, Double(remaining.seconds) + Double(remaining.attoseconds) / 1e18))
        config.timeoutIntervalForRequest = timeout
        config.timeoutIntervalForResource = timeout
        let session = URLSession(configuration: config, delegate: transfer, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: input.url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpMethod = "POST"
        request.setValue("Bearer " + input.key, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(input.body)
        let wire = request
        do {
            return try await NativeDeadline.run(until: input.deadline) {
                try await withTaskCancellationHandler {
                    let task = session.dataTask(with: wire)
                    task.resume()
                    return try await transfer.reply()
                } onCancel: { session.invalidateAndCancel() }
            }
        } catch {
            if let failure = transfer.failure { throw failure }
            if let failure = error as? HostFailure { throw failure }
            if error is CancellationError { throw error }
            if let error = error as? URLError {
                throw HostFailure(code: "PW_MODEL_NETWORK", message: "请求失败（网络错误 \(error.code.rawValue)），请检查服务地址与网络")
            }
            throw HostFailure(code: "PW_MODEL_NETWORK", message: "请求失败，请检查服务地址与网络")
        }
    }

    /// Header names are normalized for shared response consumers without passing Foundation objects across actors.
    fileprivate static func headers(_ response: HTTPURLResponse) -> [String: String] {
        var result: [String: String] = [:]
        for (name, value) in response.allHeaderFields {
            if let name = name as? String, let value = value as? String { result[name.lowercased()] = value }
        }
        return result
    }

    /// Body errors omit the request URL, provider response fragments and credentials.
    fileprivate static func invalid(_ message: String) -> HostFailure { HostFailure(code: "PW_MODEL_RESPONSE", message: message) }
}

/// One request's delegate owns redirect policy, per-chunk body collection and the exactly-once completion bridge.
private final class NativeProviderTransfer: NSObject, URLSessionDataDelegate {
    /// All mutable transfer state, including the single completion slot, lives behind this one mutex.
    private struct State {
        /// The first policy or cap failure stays authoritative over later transport errors.
        var failure: HostFailure?
        /// Once HTTPS is encountered, every later hop must remain HTTPS.
        var secureSeen: Bool
        /// Ten followed hops are the unchanged provider redirect ceiling.
        var count = 0
        /// The final (post-redirect) HTTP response supplies status and headers at completion.
        var response: HTTPURLResponse?
        /// Body bytes are accumulated only from whole URLSession chunks already accepted under the cap.
        var body = Data()
        /// Exactly one completion is cached when the task settles before reply() registers its waiter.
        var result: Result<NativeHTTPReply, Error>?
        /// The registered waiter is resumed outside the mutex exactly once.
        var continuation: CheckedContinuation<NativeHTTPReply, Error>?
    }
    /// Immutable origin and cap plus synchronized state are safe under Foundation's Sendable delegate contract.
    private let initial: URL
    /// The transport cap governs every accumulated chunk boundary, not only the final body size.
    private let maximum: Int
    /// Concurrent delegate callbacks mutate transfer state through this one mutex.
    private let state: Mutex<State>
    /// The initial origin seeds downgrade policy before URLSession starts the request.
    init(initial: URL, maximum: Int) {
        self.initial = initial
        self.maximum = maximum
        state = Mutex(State(secureSeen: initial.scheme?.lowercased() == "https"))
    }
    /// Domain policy errors remain visible independently of Foundation's cancellation/status representation.
    var failure: HostFailure? { state.withLock { $0.failure } }

    /// The settled outcome returns even when task completion raced ahead of this suspension.
    func reply() async throws -> NativeHTTPReply {
        try await withCheckedThrowingContinuation { continuation in
            let settled = state.withLock { state -> Result<NativeHTTPReply, Error>? in
                if let result = state.result { return result }
                state.continuation = continuation
                return nil
            }
            if let settled { continuation.resume(with: settled) }
        }
    }

    /// Each redirect is validated before calling Foundation's follow completion; nil prevents the next send.
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        let next = state.withLock { state -> URLRequest? in
            do {
                guard state.count < 10 else { throw NativeNetworkPolicy.refused("服务重定向超过 10 跳上限") }
                let next = try NativeProviderHTTP.redirected(request, previous: response.url ?? initial, secureSeen: state.secureSeen)
                state.count += 1
                state.secureSeen = state.secureSeen || next.url?.scheme?.lowercased() == "https"
                return next
            } catch let failure as HostFailure { state.failure = failure; return nil }
            catch { state.failure = NativeNetworkPolicy.refused("服务重定向无效"); return nil }
        }
        completionHandler(next)
    }

    /// The final response is checked for HTTP identity and announced length before any body byte is accepted.
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void) {
        let allowed = state.withLock { state -> Bool in
            if state.failure != nil { return false }
            guard let response = response as? HTTPURLResponse else {
                state.failure = NativeProviderHTTP.invalid("服务响应不是 HTTP")
                return false
            }
            guard response.expectedContentLength <= Int64(maximum) else {
                state.failure = NativeProviderHTTP.invalid("服务响应超过大小上限")
                return false
            }
            state.response = response
            return true
        }
        completionHandler(allowed ? .allow : .cancel)
    }

    /// Whole data chunks are accepted or rejected at the chunk boundary, never appended past the cap.
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        state.withLock { state in
            guard state.failure == nil else { return }
            guard state.body.count + data.count <= maximum else {
                state.failure = NativeProviderHTTP.invalid("服务响应超过大小上限")
                dataTask.cancel()
                return
            }
            state.body.append(data)
        }
    }

    /// Completion prefers the recorded policy/cap failure, maps Foundation cancellation and settles exactly once.
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let settled = state.withLock { state -> (CheckedContinuation<NativeHTTPReply, Error>?, Result<NativeHTTPReply, Error>)? in
            guard state.result == nil else { return nil }
            let result: Result<NativeHTTPReply, Error>
            if let failure = state.failure { result = .failure(failure) }
            else if let error { result = .failure(Self.transport(error)) }
            else if let response = state.response {
                result = .success(NativeHTTPReply(status: response.statusCode, headers: NativeProviderHTTP.headers(response), body: state.body))
            } else { result = .failure(NativeProviderHTTP.invalid("服务响应不是 HTTP")) }
            state.result = result
            let waiter = state.continuation
            state.continuation = nil
            return (waiter, result)
        }
        if let settled { settled.0?.resume(with: settled.1) }
    }

    /// Foundation's cancellation becomes CancellationError; other transport errors keep their identity for post's mapping.
    private static func transport(_ error: Error) -> Error {
        (error as NSError).code == NSURLErrorCancelled ? CancellationError() : error
    }
}
