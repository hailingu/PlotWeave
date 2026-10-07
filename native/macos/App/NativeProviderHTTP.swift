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

    /// The whole nonstreaming POST, redirected headers and decoded body consume one monotonic budget.
    func post(_ input: NativeProviderRequest) async throws -> NativeHTTPReply {
        try NativeNetworkPolicy.provider(input.url)
        guard !input.key.contains("\r"), !input.key.contains("\n"), input.maximum >= 0 else {
            throw HostFailure(code: "PW_KEY_ERROR", message: "API key 或响应限额无效")
        }
        let redirect = NativeProviderRedirect(initial: input.url)
        let config = configuration()
        config.httpShouldSetCookies = false
        config.httpCookieStorage = nil
        config.urlCredentialStorage = nil
        config.urlCache = nil
        let remaining = ContinuousClock.now.duration(to: input.deadline).components
        let timeout = max(0.001, min(300, Double(remaining.seconds) + Double(remaining.attoseconds) / 1e18))
        config.timeoutIntervalForRequest = timeout
        config.timeoutIntervalForResource = timeout
        let session = URLSession(configuration: config, delegate: redirect, delegateQueue: nil)
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
                    let (bytes, response) = try await session.bytes(for: wire)
                    if let failure = redirect.failure { throw failure }
                    guard let response = response as? HTTPURLResponse else { throw Self.invalid("服务响应不是 HTTP") }
                    guard response.expectedContentLength <= Int64(input.maximum) else { throw Self.invalid("服务响应超过大小上限") }
                    let body = try await Self.read(bytes, maximum: input.maximum)
                    if let failure = redirect.failure { throw failure }
                    return NativeHTTPReply(status: response.statusCode, headers: Self.headers(response), body: body)
                } onCancel: { session.invalidateAndCancel() }
            }
        } catch {
            if let failure = redirect.failure { throw failure }
            if let failure = error as? HostFailure { throw failure }
            if error is CancellationError { throw error }
            if let error = error as? URLError {
                throw HostFailure(code: "PW_MODEL_NETWORK", message: "请求失败（网络错误 \(error.code.rawValue)），请检查服务地址与网络")
            }
            throw HostFailure(code: "PW_MODEL_NETWORK", message: "请求失败，请检查服务地址与网络")
        }
    }

    /// The byte reader rejects before appending past the cap and checks cancellation during cached-buffer iteration.
    private static func read(_ bytes: URLSession.AsyncBytes, maximum: Int) async throws -> Data {
        var output = Data()
        for try await byte in bytes {
            if output.count.isMultiple(of: 4096) { try Task.checkCancellation() }
            guard output.count < maximum else { throw invalid("服务响应超过大小上限") }
            output.append(byte)
        }
        try Task.checkCancellation()
        return output
    }

    /// Header names are normalized for shared response consumers without passing Foundation objects across actors.
    private static func headers(_ response: HTTPURLResponse) -> [String: String] {
        var result: [String: String] = [:]
        for (name, value) in response.allHeaderFields {
            if let name = name as? String, let value = value as? String { result[name.lowercased()] = value }
        }
        return result
    }

    /// Body errors omit the request URL, provider response fragments and credentials.
    private static func invalid(_ message: String) -> HostFailure { HostFailure(code: "PW_MODEL_RESPONSE", message: message) }
}

/// URLSession's concurrent redirect callbacks share a mutexed policy state; no unchecked conformance is needed.
private final class NativeProviderRedirect: NSObject, URLSessionTaskDelegate {
    /// HTTPS history and the ten-hop ceiling apply to the whole request chain.
    private struct State {
        /// The first refusal stays authoritative even if Foundation returns its redirect response as a value.
        var failure: HostFailure?
        /// Once HTTPS is encountered, every later hop must remain HTTPS.
        var secureSeen: Bool
        /// Ten followed hops are the unchanged provider redirect ceiling.
        var count = 0
    }
    /// Immutable origin and synchronized state are safe under Foundation's Sendable delegate contract.
    private let initial: URL
    /// Concurrent delegate callbacks mutate policy history through this one mutex.
    private let state: Mutex<State>
    /// The initial origin seeds downgrade policy before URLSession starts the request.
    init(initial: URL) {
        self.initial = initial
        state = Mutex(State(secureSeen: initial.scheme?.lowercased() == "https"))
    }
    /// Domain policy errors remain visible independently of Foundation's cancellation/status representation.
    var failure: HostFailure? { state.withLock { $0.failure } }
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
}
