import Foundation
import Network
import Synchronization
import Testing
@testable import PlotWeaveNative

/// Runs the production TLS/send/read path against an owned loopback server, never the public endpoint under test.
@Suite(.serialized)
struct NativePinnedHTTPExecutionTests {
    /// Inspection factories stop before any actual connection is created.
    private enum FixtureStop: Error { case inspected }

    /// Every untrusted destination and origin mismatch must be rejected before a connection factory is consulted.
    @Test(arguments: ["127.0.0.1", "10.1.2.3", "169.254.1.1", "100.64.0.1", "198.18.0.1", "::1", "::ffff:127.0.0.1", "64:ff9b::a00:1"])
    func unsafeAddressesNeverCreateConnections(_ address: String) async throws {
        do {
            _ = try await NativePinnedHTTP.perform(request(address: address), makeConnection: { _, _ in
                Issue.record("A rejected address reached connection creation")
                throw FixtureStop.inspected
            })
            Issue.record("Unsafe address was accepted")
        } catch let failure as HostFailure { #expect(failure.code == "PW_NETWORK_REFUSED") }
    }

    /// The selected numeric address is typed; original hostname/port remain the TLS and HTTP identity.
    @Test(arguments: ["8.8.8.8", "2606:4700:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808"])
    func validatedEndpointPrefersDirectConnections(_ address: String) async throws {
        do {
            _ = try await NativePinnedHTTP.perform(request(address: address), makeConnection: { endpoint, parameters in
                guard case let .hostPort(host, port) = endpoint else { Issue.record("Unexpected endpoint kind"); throw FixtureStop.inspected }
                switch host {
                case .ipv4(let value): #expect(value == IPv4Address(address))
                case .ipv6(let value): #expect(value == IPv6Address(address))
                default: Issue.record("A hostname could trigger a second DNS lookup")
                }
                #expect(port.rawValue == 443)
                #expect(parameters.preferNoProxies)
                #expect(parameters.defaultProtocolStack.applicationProtocols.contains { $0 is NWProtocolTLS.Options })
                #expect(parameters.defaultProtocolStack.transportProtocol is NWProtocolTCP.Options)
                throw FixtureStop.inspected
            })
            Issue.record("Inspection factory unexpectedly returned")
        } catch FixtureStop.inspected { }
    }

    /// URL identity disagreement and userinfo cannot pass through a valid public address to a local fixture.
    @Test func originValidationPrecedesConnectionCreation() async throws {
        let urls = ["https://other.invalid/image.png", "https://fixture.invalid:8443/image.png", "https://user:password@fixture.invalid/image.png"]
        for value in urls {
            let input = try request(url: value)
            do {
                _ = try await NativePinnedHTTP.perform(input, makeConnection: { _, _ in
                    Issue.record("Invalid origin reached connection creation"); throw FixtureStop.inspected
                })
                Issue.record("Invalid origin was accepted")
            } catch let failure as HostFailure { #expect(failure.code == "PW_NETWORK_REFUSED") }
        }
    }

    /// Production default trust rejects the synthetic issuer; a test anchor still enforces the original hostname.
    @Test func tlsTrustAndHostnameAreBothRequired() async throws {
        let certificate = try NativeLocalTLSFixture.certificate()
        let server = try NativeLocalTLSFixture(certificate: certificate, reply: .bytes(response("trusted")))
        defer { server.close() }
        try await server.start()
        try await expectNetworkFailure(request(), factory: server.factory())
        #expect(server.requests.isEmpty)
        let reply = try await NativePinnedHTTP.perform(request(), makeConnection: server.factory(anchor: certificate.anchor))
        #expect(reply.status == 200)
        #expect(reply.body == Data("trusted".utf8))
        let mismatch = try request(url: "https://other.invalid/image.png", hostname: "other.invalid")
        try await expectNetworkFailure(mismatch, factory: server.factory(anchor: certificate.anchor))
        #expect(server.requests.count == 1)
    }

    /// The real wire has original authority/path and no credentials, and repeated URLs receive fresh server bytes.
    @Test func directRequestsCarryNoAmbientCredentialsOrCachedResponse() async throws {
        let certificate = try NativeLocalTLSFixture.certificate()
        for body in ["first", "second"] {
            let server = try NativeLocalTLSFixture(certificate: certificate, reply: .bytes(response(body)))
            defer { server.close() }
            try await server.start()
            let input = try request(url: "https://fixture.invalid:8443/path%20name.png?synthetic=only", port: 8443)
            let reply = try await NativePinnedHTTP.perform(input, makeConnection: server.factory(anchor: certificate.anchor))
            #expect(reply.body == Data(body.utf8))
            let wire = try #require(server.requests.first)
            #expect(wire.hasPrefix("GET /path%20name.png?synthetic=only HTTP/1.1\r\nHost: fixture.invalid:8443\r\n"))
            #expect(wire.contains("Accept-Encoding: identity\r\n"))
            #expect(wire.contains("Connection: close\r\n"))
            #expect(!wire.lowercased().contains("authorization:"))
            #expect(!wire.lowercased().contains("cookie:"))
            #expect(server.requests.count == 1)
        }
    }

    /// Cancellation after a real request closes its actual client connection, including a blocked receive.
    @Test func cancellationAndDeadlineCancelTheOwnedConnection() async throws {
        let certificate = try NativeLocalTLSFixture.certificate()
        for cancel in [true, false] {
            let server = try NativeLocalTLSFixture(certificate: certificate, reply: .stall)
            defer { server.close() }
            try await server.start()
            let connection = Mutex<NWConnection?>(nil)
            let factory = server.factory(anchor: certificate.anchor)
            let input = try request(timeout: cancel ? .seconds(3) : .seconds(1))
            let task = Task {
                try await NativePinnedHTTP.perform(input, makeConnection: { endpoint, parameters in
                    let value = try factory(endpoint, parameters)
                    connection.withLock { $0 = value }
                    return value
                })
            }
            defer { task.cancel() }
            try await NativeLocalTLSFixture.wait { !server.requests.isEmpty }
            if cancel { task.cancel() }
            do { _ = try await task.value; Issue.record("Pending request completed as success") }
            catch is CancellationError { #expect(cancel) }
            catch let failure as HostFailure { #expect(!cancel && failure.code == "PW_MODEL_TIMEOUT") }
            try await NativeLocalTLSFixture.wait {
                if case .cancelled = connection.withLock({ $0?.state }) { return true }
                return false
            }
        }
    }

    /// Reported proxy use or missing route evidence must stop the actual TLS connection before HTTP bytes are sent.
    @Test(arguments: [NativePinnedHTTP.RouteEvidence.proxy, .unavailable])
    func nonDirectEvidenceCannotSendImageRequest(_ evidence: NativePinnedHTTP.RouteEvidence) async throws {
        let certificate = try NativeLocalTLSFixture.certificate()
        let server = try NativeLocalTLSFixture(certificate: certificate, reply: .bytes(response("must-not-send")))
        defer { server.close() }
        try await server.start()
        let inspections = Mutex(0)
        do {
            _ = try await NativePinnedHTTP.perform(request(), makeConnection: server.factory(anchor: certificate.anchor), inspectRoute: { _ in
                inspections.withLock { $0 += 1 }
                return evidence
            })
            Issue.record("Non-direct route evidence allowed an image request")
        } catch let failure as HostFailure { #expect(failure.code == "PW_NETWORK_REFUSED") }
        #expect(inspections.withLock { $0 } == 1)
        #expect(server.requests.isEmpty)
    }

    /// An oversized declared body fails in the real receive/parser path instead of allocating an unbounded payload.
    @Test func oversizedResponseFailsBeforeReturningBody() async throws {
        let certificate = try NativeLocalTLSFixture.certificate()
        let server = try NativeLocalTLSFixture(certificate: certificate, reply: .bytes(response("oversized")))
        defer { server.close() }
        try await server.start()
        do {
            _ = try await NativePinnedHTTP.perform(request(maximum: 2), makeConnection: server.factory(anchor: certificate.anchor))
            Issue.record("Oversized body was accepted")
        } catch let failure as HostFailure { #expect(failure.code == "PW_HTTP_INVALID") }
    }

    /// Requests contain only synthetic public identity; the injected factory is the only connection destination owner.
    private func request(url: String = "https://fixture.invalid/image.png?synthetic=only", address: String = "8.8.8.8", hostname: String = "fixture.invalid", port: UInt16 = 443, maximum: Int = 64, timeout: Duration = .seconds(3)) throws -> NativeDownloadRequest {
        NativeDownloadRequest(url: try #require(URL(string: url)), address: address, hostname: hostname, port: port,
                              deadline: .now.advanced(by: timeout), maximum: maximum)
    }

    /// A finite complete response exercises the same parser as a real image body without needing an image decoder.
    private func response(_ body: String) -> Data {
        Data("HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: \(body.utf8.count)\r\n\r\n\(body)".utf8)
    }

    /// Sanitized failures never disclose signed query strings or a raw network endpoint.
    private func expectNetworkFailure(_ input: NativeDownloadRequest, factory: NativePinnedHTTP.ConnectionFactory) async throws {
        do { _ = try await NativePinnedHTTP.perform(input, makeConnection: factory); Issue.record("Invalid TLS identity was accepted") }
        catch let failure as HostFailure {
            #expect(["PW_DOWNLOAD_NETWORK", "PW_MODEL_TIMEOUT"].contains(failure.code))
            #expect(!failure.message.contains("synthetic=only"))
            #expect(!failure.message.contains(input.address))
        }
    }
}
