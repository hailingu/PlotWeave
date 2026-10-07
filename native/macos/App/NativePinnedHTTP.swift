import Foundation
import Network
import Security
import Synchronization

/// Readonly HTTPS media transport connects to a validated numeric address with the original TLS identity.
enum NativePinnedHTTP {
    /// One connection/task owns the full send/read lifecycle and is cancelled on deadline or caller release.
    static func perform(_ request: NativeDownloadRequest) async throws -> NativeHTTPReply {
        guard NativeNetworkPolicy.isPublic(request.address), let port = NWEndpoint.Port(rawValue: request.port) else {
            throw NativeNetworkPolicy.refused("下载连接地址未通过公网验证")
        }
        let (hostname, expectedPort) = try NativeNetworkPolicy.download(request.url)
        guard hostname == request.hostname, expectedPort == request.port else { throw NativeNetworkPolicy.refused("下载 origin 与连接身份不匹配") }
        let host = try literal(request.address)
        let tls = NWProtocolTLS.Options()
        // Apple SecProtocolOptions.h defines this as the peer-certificate verification hostname override.
        // Default trust evaluation remains active; no custom verify callback or trust bypass is installed.
        sec_protocol_options_set_tls_server_name(tls.securityProtocolOptions, hostname)
        sec_protocol_options_add_tls_application_protocol(tls.securityProtocolOptions, "http/1.1")
        let parameters = NWParameters(tls: tls, tcp: NWProtocolTCP.Options())
        let connection = NWConnection(to: .hostPort(host: host, port: port), using: parameters)
        let wire = try requestBytes(request)
        return try await NativeDeadline.run(until: request.deadline) {
            try await withTaskCancellationHandler {
                defer { connection.cancel() }
                try await ready(connection)
                try Task.checkCancellation()
                try await send(wire, connection: connection)
                return try await read(connection, maximum: request.maximum)
            } onCancel: { connection.cancel() }
        }
    }

    /// Explicit endpoint cases guarantee Network.framework never performs another DNS lookup for the connection.
    private static func literal(_ value: String) throws -> NWEndpoint.Host {
        if let address = IPv4Address(value) { return .ipv4(address) }
        if let address = IPv6Address(value) { return .ipv6(address) }
        throw NativeNetworkPolicy.refused("下载连接需要数值 IP 地址")
    }

    /// HTTP identity stays at the original host and carries no bearer, cookies, URL userinfo or proxy credentials.
    private static func requestBytes(_ input: NativeDownloadRequest) throws -> Data {
        guard let components = URLComponents(url: input.url, resolvingAgainstBaseURL: false) else { throw NativeNetworkPolicy.refused("图像 URL 非法") }
        let path = components.percentEncodedPath.isEmpty ? "/" : components.percentEncodedPath
        let target = path + (components.percentEncodedQuery.map { "?" + $0 } ?? "")
        let host = input.hostname.contains(":") ? "[" + input.hostname + "]" : input.hostname
        let authority = host + (input.port == 443 ? "" : ":\(input.port)")
        let text = "GET \(target) HTTP/1.1\r\nHost: \(authority)\r\nAccept: image/*\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n"
        guard let data = text.data(using: .ascii), data.count <= 32 * 1024 else { throw NativeNetworkPolicy.refused("图像 HTTP 请求超过上限或编码非法") }
        return data
    }

    /// State transitions use a single continuation slot, including cancellation before readiness.
    private static func ready(_ connection: NWConnection) async throws {
        let waiter = Mutex<CheckedContinuation<Void, Error>?>(nil)
        try await withCheckedThrowingContinuation { continuation in
            waiter.withLock { $0 = continuation }
            connection.stateUpdateHandler = { state in
                let result: Result<Void, Error>
                switch state {
                case .ready: result = .success(())
                case .failed: result = .failure(networkFailure())
                case .cancelled: result = .failure(CancellationError())
                default: return
                }
                let taken = waiter.withLock { current in let taken = current; current = nil; return taken }
                taken?.resume(with: result)
            }
            connection.start(queue: DispatchQueue(label: "plotweave.native.public-media"))
        }
    }

    /// Network's completion describes one send; a failed write cannot proceed to response parsing.
    private static func send(_ data: Data, connection: NWConnection) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.send(content: data, completion: .contentProcessed { error in
                if error != nil { continuation.resume(throwing: networkFailure()) }
                else { continuation.resume() }
            })
        }
    }

    /// Bounded receive buffers feed the independent framing parser until a complete reply or visible failure.
    private static func read(_ connection: NWConnection, maximum: Int) async throws -> NativeHTTPReply {
        var parser = NativeHTTPParser(maximum: maximum)
        while true {
            try Task.checkCancellation()
            let (data, eof) = try await receive(connection)
            if let complete = try parser.append(data, eof: eof) { return complete }
        }
    }

    /// Network delivers each registered receive exactly once, including cancellation/error completion.
    private static func receive(_ connection: NWConnection) async throws -> (Data, Bool) {
        try await withCheckedThrowingContinuation { continuation in
            connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { data, _, eof, error in
                if error != nil { continuation.resume(throwing: networkFailure()) }
                else { continuation.resume(returning: (data ?? Data(), eof)) }
            }
        }
    }

    /// Error text intentionally excludes signed URLs, raw Network endpoints and provider content.
    private static func networkFailure() -> HostFailure { HostFailure(code: "PW_DOWNLOAD_NETWORK", message: "图像 HTTPS 下载连接失败，请检查网络与服务证书") }
}
