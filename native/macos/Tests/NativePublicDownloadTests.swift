import Foundation
import Synchronization
import Testing
@testable import PlotWeaveNative

/// Injected DNS/transport policy cases never resolve a real hostname or connect to the internet.
struct NativePublicDownloadTests {
    /// The resolved public address is the connection endpoint; the original host remains the TLS identity.
    @Test func publicResolutionPinsAddressWithoutReplacingTLSHostname() async throws {
        let seen = Mutex<[NativeDownloadRequest]>([])
        let download = NativePublicDownload(resolver: { _, _ in ["203.0.113.7", "198.51.100.8"] }, transport: { request in
            seen.withLock { $0.append(request) }
            return NativeHTTPReply(status: 200, headers: [:], body: Data("png".utf8))
        })
        let result = try await download.fetch("https://images.example/frame.png", deadline: Self.deadline)
        #expect(result == Data("png".utf8))
        #expect(seen.withLock { $0.first?.address } == "203.0.113.7")
        #expect(seen.withLock { $0.first?.hostname } == "images.example")
        #expect(seen.withLock { $0.first?.url.host } == "images.example")
    }

    /// One unsafe DNS result refuses the whole set, not just a preferred safe answer.
    @Test func mixedDNSAndPrivateLiteralNeverReachTransport() async throws {
        let calls = Mutex(0)
        let download = NativePublicDownload(resolver: { _, _ in ["203.0.113.7", "127.0.0.1"] }, transport: { _ in
            calls.withLock { $0 += 1 }
            return NativeHTTPReply(status: 200, headers: [:], body: Data())
        })
        for url in ["https://images.example/a", "https://10.0.0.1/a", "https://[::ffff:127.0.0.1]/a", "https://[64:ff9b::7f00:1]/a", "http://203.0.113.7/a"] {
            await #expect(throws: HostFailure.self) { try await download.fetch(url, deadline: Self.deadline) }
        }
        #expect(calls.withLock { $0 } == 0)
    }

    /// Redirects re-enter DNS validation before another connection and cannot cross to an internal target.
    @Test func redirectRevalidatesAllAnswersAndStopsPrivateTarget() async throws {
        let calls = Mutex(0)
        let download = NativePublicDownload(resolver: { host, _ in host == "images.example" ? ["203.0.113.7"] : ["192.168.1.1"] }, transport: { _ in
            calls.withLock { $0 += 1 }
            return NativeHTTPReply(status: 302, headers: ["location": "https://private.example/a"], body: Data())
        })
        await #expect(throws: HostFailure.self) { try await download.fetch("https://images.example/a", deadline: Self.deadline) }
        #expect(calls.withLock { $0 } == 1)
    }

    /// Relative redirects retain the original identity while the existing five-hop ceiling stays bounded.
    @Test func relativeRedirectSucceedsAndCycleIsBounded() async throws {
        let paths = Mutex<[String]>([])
        let download = NativePublicDownload(resolver: { _, _ in ["203.0.113.7"] }, transport: { request in
            paths.withLock { $0.append(request.url.path) }
            return request.url.path == "/a" ? NativeHTTPReply(status: 302, headers: ["location": "/b"], body: Data()) : NativeHTTPReply(status: 200, headers: [:], body: Data([1]))
        })
        #expect(try await download.fetch("https://images.example/a", deadline: Self.deadline) == Data([1]))
        #expect(paths.withLock { $0 } == ["/a", "/b"])
        let calls = Mutex(0)
        let loop = NativePublicDownload(resolver: { _, _ in ["203.0.113.7"] }, transport: { _ in
            calls.withLock { $0 += 1 }
            return NativeHTTPReply(status: 302, headers: ["location": "/a"], body: Data())
        })
        await #expect(throws: HostFailure.self) { try await loop.fetch("https://images.example/a", deadline: Self.deadline) }
        #expect(calls.withLock { $0 } == 6)
    }

    /// Cancelled, expired and oversized work cannot return a successful body to an image writer.
    @Test func cancellationDeadlineAndBodyLimitReject() async throws {
        let calls = Mutex(0)
        let download = NativePublicDownload(resolver: { _, _ in ["203.0.113.7"] }, transport: { _ in
            calls.withLock { $0 += 1 }
            return NativeHTTPReply(status: 200, headers: [:], body: Data(repeating: 0, count: 5))
        }, maximum: 4)
        await #expect(throws: HostFailure.self) { try await download.fetch("https://images.example/a", deadline: Self.deadline, isCancelled: { true }) }
        await #expect(throws: HostFailure.self) { try await download.fetch("https://images.example/a", deadline: .now.advanced(by: .seconds(-1))) }
        #expect(calls.withLock { $0 } == 0)
        await #expect(throws: HostFailure.self) { try await download.fetch("https://images.example/a", deadline: Self.deadline) }
        let slow = NativePublicDownload(resolver: { _, _ in try await Task.sleep(for: .seconds(10)); return ["203.0.113.7"] }, transport: download.transport)
        let start = ContinuousClock.now
        await #expect(throws: HostFailure.self) { try await slow.fetch("https://images.example/a", deadline: .now.advanced(by: .milliseconds(20))) }
        #expect(start.duration(to: .now) < .seconds(1))
    }

    /// All non-2xx replies remain visible errors rather than becoming invalid generated files.
    @Test func responseFailureAndMissingRedirectLocationReject() async throws {
        for status in [302, 403] {
            let download = NativePublicDownload(resolver: { _, _ in ["203.0.113.7"] }, transport: { _ in NativeHTTPReply(status: status, headers: [:], body: Data()) })
            await #expect(throws: HostFailure.self) { try await download.fetch("https://images.example/a", deadline: Self.deadline) }
        }
    }

    /// Each case receives a fresh monotonic budget, independent from wall-clock changes.
    private static var deadline: ContinuousClock.Instant { .now.advanced(by: .seconds(5)) }
}

/// Raw split buffers exercise the framing contract independently from Network.framework callbacks.
struct NativeHTTPParserTests {
    /// Chunk decoding stays bounded even when headers, length lines and bodies arrive one byte at a time.
    @Test func chunkedResponseDecodesIncrementally() throws {
        var parser = NativeHTTPParser(maximum: 16)
        let bytes = Data("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\nX-End: yes\r\n\r\n".utf8)
        var result: NativeHTTPReply?
        for byte in bytes { if let reply = try parser.append(Data([byte])) { result = reply } }
        #expect(result?.body == Data("abcde".utf8))
        #expect(result?.status == 200)
    }

    /// Wire metadata consumes a separate total transfer budget even when decoded chunks remain tiny.
    @Test func cumulativeChunkMetadataCannotExceedTransferBudget() throws {
        var parser = NativeHTTPParser(maximum: 8, headerMaximum: 128)
        let chunk = "1;" + String(repeating: "x", count: 90) + "\r\na\r\n"
        let response = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n" + String(repeating: chunk, count: 4) + "0\r\n\r\n"
        #expect(throws: HostFailure.self) { try parser.append(Data(response.utf8), eof: true) }
    }

    /// Content-length succeeds exactly and EOF cannot turn a truncated body into a valid reply.
    @Test func fixedAndCloseDelimitedResponsesRequireCompleteFraming() throws {
        var fixed = NativeHTTPParser(maximum: 4)
        #expect(try fixed.append(Data("HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc".utf8))?.body == Data("abc".utf8))
        var truncated = NativeHTTPParser(maximum: 4)
        #expect(throws: HostFailure.self) { try truncated.append(Data("HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\na".utf8), eof: true) }
        var closed = NativeHTTPParser(maximum: 4)
        #expect(try closed.append(Data("HTTP/1.1 200 OK\r\n\r\nabc".utf8), eof: false) == nil)
        #expect(try closed.append(Data(), eof: true)?.body == Data("abc".utf8))
    }

    /// Header, chunk, decoded-body and ambiguous-framing limits reject before unbounded aggregation.
    @Test func excessiveAndAmbiguousResponsesReject() throws {
        let cases = ["HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nabcde", "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nabcde\r\n0\r\n\r\n", "HTTP/1.1 200 OK\r\nContent-Length: 3\r\nTransfer-Encoding: chunked\r\n\r\n", "HTTP/1.1 200 OK\r\nContent-Length: 3\r\nContent-Length: 4\r\n\r\n", "HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 3\r\n\r\nabc"]
        for response in cases {
            var parser = NativeHTTPParser(maximum: 4)
            #expect(throws: HostFailure.self) { try parser.append(Data(response.utf8), eof: true) }
        }
        var headers = NativeHTTPParser(maximum: 4, headerMaximum: 32)
        #expect(throws: HostFailure.self) { try headers.append(Data("HTTP/1.1 200 OK\r\nX-Huge: ".utf8) + Data(repeating: 97, count: 100)) }
    }
}
