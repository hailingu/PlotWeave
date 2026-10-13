import Foundation
import Synchronization
import Testing
@testable import PlotWeaveNative

/// URLProtocol exercises the real URLSession byte reader without network access, DNS or billable calls.
struct NativeProviderHTTPTests {
    /// Successful HTTPS reads retain bearer authentication and return bounded response bytes.
    @Test func providerPOSTUsesRealURLSessionWithInjectedProtocol() async throws {
        let fixture = try Fixture(status: 200, body: Data("{\"choices\":[]}".utf8))
        defer { fixture.remove() }
        let result = try await fixture.transport.post(fixture.request())
        #expect(result.status == 200)
        #expect(result.body == fixture.entry.reply?.body)
        #expect(fixture.entry.requests.withLock { $0.first?.httpMethod } == "POST")
        #expect(fixture.entry.requests.withLock { $0.first?.value(forHTTPHeaderField: "Authorization") } == "Bearer fixture-key")
    }

    /// The byte cap applies while reading, and a stalled response is cancelled at the monotonic deadline.
    @Test func excessiveBodyAndStalledRequestRejectAndCancelSession() async throws {
        let oversized = try Fixture(status: 200, body: Data(repeating: 1, count: 5))
        defer { oversized.remove() }
        await #expect(throws: HostFailure.self) { try await oversized.transport.post(oversized.request(maximum: 4)) }
        let stalled = try Fixture(status: nil, body: Data())
        defer { stalled.remove() }
        let started = ContinuousClock.now
        await #expect(throws: HostFailure.self) { try await stalled.transport.post(stalled.request(timeout: .milliseconds(30))) }
        #expect(started.duration(to: .now) < .seconds(1))
        for _ in 0..<100 {
            if stalled.entry.stopped.withLock({ $0 > 0 }) { break }
            try await Task.sleep(for: .milliseconds(2))
        }
        #expect(stalled.entry.stopped.withLock { $0 } > 0)
    }

    /// Remote plaintext HTTP is refused before URLSession/credentials; explicit loopback remains compatible.
    @Test func providerURLBoundaryRejectsBeforeSending() async throws {
        let fixture = try Fixture(status: 200, body: Data())
        defer { fixture.remove() }
        var request = fixture.request()
        request = NativeProviderRequest(url: try #require(URL(string: "http://" + fixture.host + "/v1")), key: request.key, body: request.body, deadline: request.deadline, maximum: request.maximum)
        await #expect(throws: HostFailure.self) { try await fixture.transport.post(request) }
        #expect(fixture.entry.requests.withLock { $0 }.isEmpty)
        try NativeNetworkPolicy.provider(try Self.url("http://127.0.0.8:1234/v1"))
        #expect(throws: HostFailure.self) { try NativeNetworkPolicy.provider(try Self.url("http://localhost/v1"), secureSeen: true) }
    }

    /// Redirect policy independently proves cross-origin bearer removal and HTTPS downgrade refusal.
    @Test func redirectChangesCredentialAuthorityAndNeverDowngrades() throws {
        let first = try Self.url("https://provider.example/v1")
        var request = URLRequest(url: try Self.url("https://other.example/v1"))
        request.setValue("Bearer fixture-key", forHTTPHeaderField: "Authorization")
        let stripped = try NativeProviderHTTP.redirected(request, previous: first, secureSeen: true)
        #expect(stripped.value(forHTTPHeaderField: "Authorization") == nil)
        request.url = try Self.url("https://provider.example/v2")
        #expect(try NativeProviderHTTP.redirected(request, previous: first, secureSeen: true).value(forHTTPHeaderField: "Authorization") == "Bearer fixture-key")
        request.url = try Self.url("http://localhost/v1")
        #expect(throws: HostFailure.self) { try NativeProviderHTTP.redirected(request, previous: first, secureSeen: true) }
    }

    /// Test URLs use a checked helper so malformed fixture edits fail visibly without force unwraps.
    private static func url(_ value: String) throws -> URL {
        guard let url = URL(string: value) else { throw HostFailure(code: "PW_TEST_URL", message: "invalid fixture URL") }
        return url
    }

    /// Each fixture registers one unique URLProtocol origin, so parallel tests cannot exchange reply data.
    private struct Fixture {
        /// Synthetic host and locked request observations remain local to this test's protocol registry key.
        let host: String
        let url: URL
        let entry: ProviderHTTPFixtureProtocol.Entry
        let transport: NativeProviderHTTP
        /// The real transport receives only a fresh ephemeral configuration with this URLProtocol type.
        init(status: Int?, body: Data) throws {
            host = "pw-" + UUID().uuidString.lowercased() + ".example"
            url = try NativeProviderHTTPTests.url("https://" + host + "/v1")
            entry = ProviderHTTPFixtureProtocol.Entry(reply: status.map { NativeHTTPReply(status: $0, headers: [:], body: body) })
            ProviderHTTPFixtureProtocol.register(host, entry: entry)
            transport = NativeProviderHTTP(configuration: {
                let config = URLSessionConfiguration.ephemeral
                config.protocolClasses = [ProviderHTTPFixtureProtocol.self]
                return config
            })
        }
        /// Test deadlines/caps can be short without altering the production contract.
        func request(maximum: Int = 1024, timeout: Duration = .seconds(2)) -> NativeProviderRequest {
            NativeProviderRequest(url: url, key: "fixture-key", body: .object(["model": .string("fixture-model")]), deadline: .now.advanced(by: timeout), maximum: maximum)
        }
        /// Registry cleanup occurs only after URLSession has settled and invalidated its owned tasks.
        func remove() { ProviderHTTPFixtureProtocol.remove(host) }
    }
}

/// Foundation owns URLProtocol callbacks; the fixture has no unsynchronized mutable state of its own.
/// This test-only inherited Foundation lifecycle requires unchecked Sendable, with shared data protected by Mutex.
private final class ProviderHTTPFixtureProtocol: URLProtocol, @unchecked Sendable {
    /// One immutable response and mutexed callback observations belong to a unique fixture origin.
    final class Entry: Sendable {
        /// Nil simulates a stalled external server, cancelled by the production session deadline.
        let reply: NativeHTTPReply?
        /// Foundation callbacks may occur on different worker threads; observations stay serialized.
        let requests = Mutex<[URLRequest]>([])
        let stopped = Mutex(0)
        /// The entry is fully initialized before registration or protocol callback visibility.
        init(reply: NativeHTTPReply?) { self.reply = reply }
    }
    /// The registry is thread safe and keyed by a fresh host for every parallel test.
    private static let entries = Mutex<[String: Entry]>([:])
    /// Registration never mutates a running entry's response.
    static func register(_ host: String, entry: Entry) { entries.withLock { $0[host] = entry } }
    /// Tests remove only their own origin after the transport closes.
    static func remove(_ host: String) { _ = entries.withLock { $0.removeValue(forKey: host) } }
    /// Only explicit fixture origins are intercepted; test construction never falls through to actual network.
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host.map { host in entries.withLock { $0[host] != nil } } ?? false }
    /// Canonicalization preserves the request under observation.
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    /// The real URLSession consumes status and body through its ordinary delegate/byte reader.
    override func startLoading() {
        guard let url = request.url, let host = url.host, let entry = Self.entries.withLock({ $0[host] }) else { return }
        entry.requests.withLock { $0.append(request) }
        guard let reply = entry.reply else { return }
        guard let response = HTTPURLResponse(url: url, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers) else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse)); return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: reply.body)
        client?.urlProtocolDidFinishLoading(self)
    }
    /// A stalled fixture proves the session cancellation boundary receives the stop callback.
    override func stopLoading() {
        guard let host = request.url?.host, let entry = Self.entries.withLock({ $0[host] }) else { return }
        entry.stopped.withLock { $0 += 1 }
    }
}
