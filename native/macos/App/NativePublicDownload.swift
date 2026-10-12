import Foundation

/// Bounded HTTP reply is shared by the provider transport and the pinned read-only media transport.
struct NativeHTTPReply: Sendable, Equatable {
    /// Transport-owned status and lowercase headers describe a single hop, never an automatically followed chain.
    let status: Int
    /// Lowercase headers describe only this hop and never authorize automatic redirects.
    let headers: [String: String]
    /// Body bytes have already passed the transport framing and aggregation bounds.
    let body: Data
}

/// One media hop fixes the validated address separately from its TLS/certificate and HTTP hostname.
struct NativeDownloadRequest: Sendable {
    /// URL remains the authoritative origin/path while address cannot be resolved again by transport.
    let url: URL
    /// Only a public numeric IP can become the actual Network.framework endpoint.
    let address: String
    /// Original hostname remains both HTTP authority and TLS certificate identity.
    let hostname: String
    /// Validated origin port stays bound to the request URL.
    let port: UInt16
    /// Per-hop time is bounded by the remaining absolute image-job budget.
    let deadline: ContinuousClock.Instant
    /// Decoded media bytes cannot exceed the generated-image contract.
    let maximum: Int
}

/// Every image URL hop validates all DNS answers, then connects only to an approved literal address.
struct NativePublicDownload: Sendable {
    /// Injected DNS and HTTP seams let tests prove the policy without calling any real network.
    typealias Resolver = @Sendable (String, ContinuousClock.Instant) async throws -> [String]
    typealias Transport = @Sendable (NativeDownloadRequest) async throws -> NativeHTTPReply
    /// Resolvers never return hostnames that would invite a second resolution in the transport.
    let resolver: Resolver
    /// Transport is narrowly scoped to one readonly HTTPS request to the pinned address.
    let transport: Transport
    /// Generated assets retain their existing 32-MiB contract; tests may inject a smaller budget.
    /// Decoded media bytes cannot exceed the generated-image contract.
    let maximum: Int

    /// Production DNS and HTTPS remain pinned behind the same injectable policy boundary.
    init() {
        resolver = NativePublicDNS.resolve
        transport = NativePinnedHTTP.perform
        maximum = 32 * 1024 * 1024
    }

    /// Explicit test injection keeps the production defaults separate from policy fixtures.
    init(resolver: @escaping Resolver, transport: @escaping Transport, maximum: Int = 32 * 1024 * 1024) {
        self.resolver = resolver
        self.transport = transport
        self.maximum = maximum
    }

    /// The caller's absolute image-job deadline covers every resolve, redirect and bounded body read.
    func fetch(_ value: String, deadline: ContinuousClock.Instant, isCancelled: @Sendable () -> Bool = { false }) async throws -> Data {
        guard var current = URL(string: value) else { throw NativeNetworkPolicy.refused("图像 URL 非法") }
        for hop in 0...5 {
            try check(deadline, isCancelled: isCancelled)
            let (host, port) = try NativeNetworkPolicy.download(current)
            let addresses: [String]
            if NativeNetworkPolicy.isLiteral(host) { addresses = [host] }
            else { addresses = try await NativeDeadline.run(until: deadline) { try await self.resolver(host, deadline) } }
            guard !addresses.isEmpty, addresses.allSatisfy(NativeNetworkPolicy.isPublic) else {
                throw NativeNetworkPolicy.refused("图像主机解析到非公网地址或没有有效地址，已拒绝下载")
            }
            try check(deadline, isCancelled: isCancelled)
            let response = try await response(url: current, host: host, port: port, addresses: addresses,
                deadline: deadline, isCancelled: isCancelled)
            try check(deadline, isCancelled: isCancelled)
            guard response.body.count <= maximum else { throw NativeNetworkPolicy.refused("下载图像超过大小上限") }
            if (300...399).contains(response.status) {
                guard hop < 5 else { throw NativeNetworkPolicy.refused("图像下载重定向超过 5 跳上限") }
                guard let location = response.headers["location"], let next = URL(string: location, relativeTo: current)?.absoluteURL else {
                    throw NativeNetworkPolicy.refused("图像重定向缺少有效 Location")
                }
                current = next
                continue
            }
            guard (200...299).contains(response.status) else { throw HostFailure(code: "PW_DOWNLOAD_STATUS", message: "图像下载服务返回 \(response.status)") }
            return response.body
        }
        throw NativeNetworkPolicy.refused("图像下载重定向超限")
    }
}

/// Monotonic budget and cancellation are checked before every external transition and returned body.
private extension NativePublicDownload {
    /// Candidate fallback shares one hop budget and retries only transport network failures, never policy or reply errors.
    func response(url: URL, host: String, port: UInt16, addresses: [String], deadline: ContinuousClock.Instant,
                  isCancelled: @Sendable () -> Bool) async throws -> NativeHTTPReply {
        let hopDeadline = min(deadline, .now.advanced(by: .seconds(120)))
        for (index, address) in addresses.enumerated() {
            try check(hopDeadline, isCancelled: isCancelled)
            let input = NativeDownloadRequest(url: url, address: address, hostname: host, port: port,
                deadline: hopDeadline, maximum: maximum)
            do { return try await NativeDeadline.run(until: hopDeadline) { try await self.transport(input) } }
            catch {
                try check(hopDeadline, isCancelled: isCancelled)
                guard let failure = error as? HostFailure, failure.code == "PW_DOWNLOAD_NETWORK", index + 1 < addresses.count else { throw error }
            }
        }
        throw NativeNetworkPolicy.refused("图像主机没有有效连接地址")
    }

    /// Checking after an await prevents an in-flight cancellation from returning bytes to the writer.
    func check(_ deadline: ContinuousClock.Instant, isCancelled: @Sendable () -> Bool) throws {
        try Task.checkCancellation()
        guard !isCancelled() else { throw HostFailure(code: "PW_CANCELLED", message: "已取消") }
        guard deadline > .now else { throw NativeDeadline.expired() }
    }
}
