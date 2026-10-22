import Darwin
import Foundation
import Synchronization

/// Blocking system DNS is isolated to at most two owned threads, with bounded waiting at its async boundary.
enum NativePublicDNS {
    /// The application shares the same two-slot resolver throughout its lifetime.
    private static let worker = Worker(lookup: addresses)

    /// The caller receives deadline/cancellation promptly even if the system resolver cannot be interrupted.
    static func resolve(_ hostname: String, deadline: ContinuousClock.Instant) async throws -> [String] {
        try await worker.resolve(hostname, deadline: deadline)
    }

    /// Per-owner resolver state allows deterministic lifecycle tests without replacing the shared system resolver.
    final class Worker: Sendable {
        /// Slots belong to blocking threads, including after their async caller has stopped waiting.
        private let active = Mutex(0)
        /// Production supplies the numeric system lookup; tests supply an isolated blocking operation.
        private let lookup: @Sendable (String) throws -> [String]

        /// Each worker retains one immutable resolver and the same two-thread resource limit.
        init(lookup: @escaping @Sendable (String) throws -> [String]) { self.lookup = lookup }

        /// Completed resolution releases its slot; abandoned waits cannot spread to the shared actor pool.
        func resolve(_ hostname: String, deadline: ContinuousClock.Instant) async throws -> [String] {
            try await NativeDeadline.run(until: deadline) { [self] in
                guard active.withLock({ count in if count >= 2 { return false }; count += 1; return true }) else {
                    throw HostFailure(code: "PW_DNS_BUSY", message: "图像 DNS 解析繁忙，请稍后重试")
                }
                return try await withCheckedThrowingContinuation { continuation in
                    Thread.detachNewThread { [self] in
                        defer { active.withLock { $0 -= 1 } }
                        do { continuation.resume(returning: try lookup(hostname)) }
                        catch { continuation.resume(throwing: error) }
                    }
                }
            }
        }
    }

    /// Numeric results are collected completely; a later policy check refuses any mixed private/public set.
    private static func addresses(_ hostname: String) throws -> [String] {
        var hints = addrinfo()
        hints.ai_family = AF_UNSPEC
        hints.ai_socktype = SOCK_STREAM
        hints.ai_protocol = IPPROTO_TCP
        var first: UnsafeMutablePointer<addrinfo>?
        let result = hostname.withCString { getaddrinfo($0, nil, &hints, &first) }
        guard result == 0, let first else { throw HostFailure(code: "PW_DNS_FAILED", message: "图像主机 DNS 解析失败") }
        defer { freeaddrinfo(first) }
        var current: UnsafeMutablePointer<addrinfo>? = first
        var output: [String] = []
        while let record = current {
            let info = record.pointee
            guard let address = info.ai_addr, info.ai_family == AF_INET || info.ai_family == AF_INET6 else {
                throw NativeNetworkPolicy.refused("DNS 返回非法地址类型")
            }
            var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(address, info.ai_addrlen, &buffer, socklen_t(buffer.count), nil, 0, NI_NUMERICHOST) == 0 else {
                throw HostFailure(code: "PW_DNS_FAILED", message: "DNS 地址转换失败")
            }
            output.append(String(cString: buffer))
            guard output.count <= 512 else { throw NativeNetworkPolicy.refused("DNS 地址数量超过上限") }
            current = info.ai_next
        }
        return output
    }
}
