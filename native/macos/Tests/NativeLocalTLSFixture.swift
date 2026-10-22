import Foundation
import Network
import Security
import Synchronization
import Testing
@testable import PlotWeaveNative

/// Owns ephemeral certificate material and a loopback-only server; it never imports into a user keychain.
final class NativeLocalTLSFixture: Sendable {
    /// Synthetic credentials exist only in process memory after their owned directory is removed.
    struct Certificate: Sendable {
        /// Password-protected synthetic PKCS#12 bytes are imported only into process memory.
        let archive: Data
        /// Only the positive fixture verifier accepts this synthetic DER certificate.
        let anchor: Data
    }
    /// Each test chooses an actual wire response or an intentionally pending receive.
    enum Reply: Sendable { case bytes(Data), stall }
    /// Listener and connection callbacks publish only receipts belonging to this server.
    private struct State {
        /// A port receipt is published only after the owned listener is ready.
        var port: NWEndpoint.Port?
        /// Listener failure terminates the bounded readiness wait.
        var failed = false
        /// Accepted sockets remain owned until explicit fixture teardown.
        var connections: [NWConnection] = []
        /// Completed HTTP headers prove application bytes reached the TLS peer.
        var requests: [String] = []
    }
    /// A reference owner lets escaping receive callbacks share a noncopyable mutex safely.
    private final class Buffer: Sendable {
        /// Only one connection contributes bytes to this bounded buffer.
        let bytes = Mutex(Data())
    }

    /// One TLS listener is restricted to the loopback endpoint.
    private let listener: NWListener
    /// The immutable response policy cannot change during a connection.
    private let reply: Reply
    /// Network callbacks share receipts through a standard-library mutex.
    private let state = Mutex(State())
    /// All listener and certificate callbacks use this fixture-owned serial queue.
    private let queue = DispatchQueue(label: "plotweave.test.local-tls")

    /// Creates a short-lived synthetic identity with a hostname distinct from the loopback endpoint.
    static func certificate(hostname: String = "fixture.invalid") throws -> Certificate {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-tls-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: root) }
        let config = """
        [req]
        distinguished_name = dn
        x509_extensions = extensions
        prompt = no
        [dn]
        CN = \(hostname)
        [extensions]
        subjectAltName = DNS:\(hostname)
        basicConstraints = critical,CA:TRUE
        keyUsage = critical,digitalSignature,keyEncipherment,keyCertSign
        extendedKeyUsage = serverAuth
        """
        try Data(config.utf8).write(to: root.appendingPathComponent("config.cnf"))
        try openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1", "-config", "config.cnf", "-keyout", "key.pem", "-out", "cert.pem"], root: root)
        try openssl(["pkcs12", "-export", "-inkey", "key.pem", "-in", "cert.pem", "-passout", "pass:fixture-only", "-out", "identity.p12"], root: root)
        try openssl(["x509", "-in", "cert.pem", "-outform", "DER", "-out", "anchor.der"], root: root)
        return try Certificate(archive: Data(contentsOf: root.appendingPathComponent("identity.p12")), anchor: Data(contentsOf: root.appendingPathComponent("anchor.der")))
    }

    /// Structured arguments and an owned working directory prevent shell expansion and accidental key disclosure.
    private static func openssl(_ arguments: [String], root: URL) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/openssl")
        process.arguments = arguments
        process.currentDirectoryURL = root
        process.environment = ["OPENSSL_CONF": root.appendingPathComponent("config.cnf").path]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        process.waitUntilExit()
        try #require(process.terminationStatus == 0, "Synthetic certificate generation failed")
    }

    /// TLS uses only an in-memory synthetic identity and binds explicitly to this process's loopback endpoint.
    init(certificate: Certificate, reply: Reply) throws {
        let options: [CFString: Any] = [kSecImportExportPassphrase: "fixture-only", kSecImportToMemoryOnly: true]
        var imported: CFArray?
        try #require(SecPKCS12Import(certificate.archive as CFData, options as CFDictionary, &imported) == errSecSuccess)
        let item = try #require((imported as? [[String: Any]])?.first)
        let raw = try #require(item[kSecImportItemIdentity as String]) as CFTypeRef
        try #require(CFGetTypeID(raw) == SecIdentityGetTypeID())
        let identity = unsafeDowncast(raw, to: SecIdentity.self)
        let tls = NWProtocolTLS.Options()
        let local = try #require(sec_identity_create(identity))
        sec_protocol_options_set_local_identity(tls.securityProtocolOptions, local)
        let parameters = NWParameters(tls: tls, tcp: NWProtocolTCP.Options())
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        listener = try NWListener(using: parameters, on: .any)
        self.reply = reply
        listener.stateUpdateHandler = { [weak self] status in
            guard let self else { return }
            switch status {
            case .ready: state.withLock { $0.port = listener.port }
            case .failed: state.withLock { $0.failed = true }
            default: break
            }
        }
        listener.newConnectionHandler = { [weak self] in self?.accept($0) }
        listener.start(queue: queue)
    }

    /// Bounded polling observes listener readiness instead of assuming that start means listening.
    func start() async throws {
        try await Self.wait { self.state.withLock { $0.port != nil || $0.failed } }
        try #require(state.withLock { !$0.failed && $0.port != nil })
    }

    /// The production factory sees the validated public endpoint; only this test redirects it to owned loopback.
    func factory(anchor: Data? = nil, observe: @escaping @Sendable (NWEndpoint, NWParameters) throws -> Void = { _, _ in }) -> NativePinnedHTTP.ConnectionFactory {
        { [self] endpoint, parameters in
            try observe(endpoint, parameters)
            if let anchor { Self.trustOnly(anchor, parameters: parameters, queue: queue) }
            let port = try #require(state.withLock { $0.port })
            return NWConnection(to: .hostPort(host: .ipv4(.loopback), port: port), using: parameters)
        }
    }

    /// Positive fixture requests still evaluate the original SSL hostname policy against one synthetic anchor.
    private static func trustOnly(_ anchor: Data, parameters: NWParameters, queue: DispatchQueue) {
        guard let tls = parameters.defaultProtocolStack.applicationProtocols.first as? NWProtocolTLS.Options else { return }
        sec_protocol_options_set_verify_block(tls.securityProtocolOptions, { _, trust, complete in
            let value = sec_trust_copy_ref(trust).takeRetainedValue()
            guard let certificate = SecCertificateCreateWithData(nil, anchor as CFData),
                  SecTrustSetAnchorCertificates(value, [certificate] as CFArray) == errSecSuccess,
                  SecTrustSetAnchorCertificatesOnly(value, true) == errSecSuccess else { complete(false); return }
            complete(SecTrustEvaluateWithError(value, nil))
        }, queue)
    }

    /// Actual request bytes, rather than a mocked transport invocation, establish header and cache behavior.
    var requests: [String] { state.withLock { $0.requests } }

    /// Teardown cancels every accepted socket and removes callbacks before the fixture is released.
    func close() {
        listener.stateUpdateHandler = nil
        listener.newConnectionHandler = nil
        listener.cancel()
        let connections = state.withLock { value in let connections = value.connections; value.connections = []; return connections }
        for connection in connections { connection.stateUpdateHandler = nil; connection.cancel() }
    }

    /// Per-connection buffering reads just one bounded HTTP header, never unbounded input from a listener.
    private func accept(_ connection: NWConnection) {
        state.withLock { $0.connections.append(connection) }
        connection.start(queue: queue)
        receive(connection, buffer: Buffer())
    }

    /// A complete request triggers the selected wire response; pending replies remain owned until close/cancellation.
    private func receive(_ connection: NWConnection, buffer: Buffer) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 32_768) { [weak self] data, _, eof, error in
            guard let self, error == nil else { connection.cancel(); return }
            let content = buffer.bytes.withLock { bytes -> Data in if let data { bytes.append(data) }; return bytes }
            guard content.count <= 32_768 else { connection.cancel(); return }
            if content.range(of: Data("\r\n\r\n".utf8)) != nil {
                state.withLock { $0.requests.append(String(decoding: content, as: UTF8.self)) }
                if case let .bytes(response) = reply {
                    connection.send(content: response, completion: .contentProcessed { _ in connection.cancel() })
                }
            } else if !eof { receive(connection, buffer: buffer) }
            else { connection.cancel() }
        }
    }

    /// All async fixtures use an observable condition and a finite local deadline.
    static func wait(_ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(4))
        while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
        try #require(condition(), "Owned network fixture did not settle")
    }
}
