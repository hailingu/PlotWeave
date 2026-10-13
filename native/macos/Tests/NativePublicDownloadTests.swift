import Foundation
import Synchronization
import Testing
@testable import PlotWeaveNative

/// Injected DNS/transport policy cases never resolve a real hostname or connect to the internet.
struct NativePublicDownloadTests {
    /// A failed approved IPv6 route must not hide bytes available through the next approved address.
    @Test func approvedAddressFallbackRetainsIdentityAndDeadline() async throws {
        let seen = Mutex<[NativeDownloadRequest]>([])
        let download = NativePublicDownload(resolver: { _, _ in ["2606:4700:4700::1111", "8.8.8.8"] }, transport: { request in
            seen.withLock { $0.append(request) }
            if request.address.contains(":") { throw HostFailure(code: "PW_DOWNLOAD_NETWORK", message: "连接失败") }
            return NativeHTTPReply(status: 200, headers: [:], body: Data([7, 8]))
        })
        #expect(try await download.fetch("https://images.example/frame.png", deadline: Self.deadline) == Data([7, 8]))
        let requests = seen.withLock { $0 }
        #expect(requests.map(\.address) == ["2606:4700:4700::1111", "8.8.8.8"])
        #expect(requests.allSatisfy { $0.hostname == "images.example" && $0.url.path == "/frame.png" && $0.port == 443 })
        #expect(requests.first?.deadline == requests.last?.deadline)
    }

    /// Every approved candidate is tried before the final network failure, with no successful body fabricated.
    @Test func networkFailuresExhaustApprovedAddresses() async throws {
        let seen = Mutex<[String]>([])
        let download = NativePublicDownload(resolver: { _, _ in ["8.8.8.8", "1.1.1.1"] }, transport: { request in
            seen.withLock { $0.append(request.address) }
            throw HostFailure(code: "PW_DOWNLOAD_NETWORK", message: "连接失败")
        })
        do { _ = try await download.fetch("https://images.example/a", deadline: Self.deadline); Issue.record("Unreachable candidates returned media") }
        catch let error as HostFailure { #expect(error.code == "PW_DOWNLOAD_NETWORK") }
        #expect(seen.withLock { $0 } == ["8.8.8.8", "1.1.1.1"])
    }

    /// A terminal policy, budget or cancellation error cannot become another endpoint attempt.
    @Test(arguments: ["PW_NETWORK_REFUSED", "PW_MODEL_TIMEOUT", "PW_CANCELLED"])
    func terminalTransportErrorsDoNotAdvanceAddress(code: String) async throws {
        let calls = Mutex(0)
        let download = NativePublicDownload(resolver: { _, _ in ["8.8.8.8", "1.1.1.1"] }, transport: { _ in
            calls.withLock { $0 += 1 }
            throw HostFailure(code: code, message: "终止")
        })
        do { _ = try await download.fetch("https://images.example/a", deadline: Self.deadline); Issue.record("Terminal error returned media") }
        catch let error as HostFailure { #expect(error.code == code) }
        #expect(calls.withLock { $0 } == 1)
    }

    /// Cancellation during a failed connection and an exhausted shared budget both stop candidate fallback.
    @Test func cancellationAndSpentBudgetDoNotAdvanceAddress() async throws {
        let cancelled = Mutex(false)
        let calls = Mutex(0)
        let download = NativePublicDownload(resolver: { _, _ in ["8.8.8.8", "1.1.1.1"] }, transport: { _ in
            calls.withLock { $0 += 1 }
            cancelled.withLock { $0 = true }
            throw HostFailure(code: "PW_DOWNLOAD_NETWORK", message: "连接失败")
        })
        do { _ = try await download.fetch("https://images.example/a", deadline: Self.deadline, isCancelled: { cancelled.withLock { $0 } }); Issue.record("Cancelled connection returned media") }
        catch let error as HostFailure { #expect(error.code == "PW_CANCELLED") }
        #expect(calls.withLock { $0 } == 1)
        let slow = NativePublicDownload(resolver: download.resolver, transport: { _ in
            calls.withLock { $0 += 1 }
            try await Task.sleep(for: .seconds(10))
            throw HostFailure(code: "PW_DOWNLOAD_NETWORK", message: "连接失败")
        })
        let start = ContinuousClock.now
        do { _ = try await slow.fetch("https://images.example/a", deadline: .now.advanced(by: .milliseconds(20))); Issue.record("Expired connection returned media") }
        catch let error as HostFailure { #expect(error.code == "PW_MODEL_TIMEOUT") }
        #expect(calls.withLock { $0 } == 2)
        #expect(start.duration(to: .now) < .seconds(1))
    }

    /// HTTP rejection and body bounds are authoritative replies rather than connection failures to retry.
    @Test(arguments: [403, 200]) func rejectedRepliesDoNotAdvanceAddress(status: Int) async throws {
        let calls = Mutex(0)
        let download = NativePublicDownload(resolver: { _, _ in ["8.8.8.8", "1.1.1.1"] }, transport: { _ in
            calls.withLock { $0 += 1 }
            return NativeHTTPReply(status: status, headers: [:], body: status == 200 ? Data([1, 2]) : Data())
        }, maximum: 1)
        do { _ = try await download.fetch("https://images.example/a", deadline: Self.deadline); Issue.record("Rejected reply returned media") }
        catch let error as HostFailure { #expect(error.code == (status == 403 ? "PW_DOWNLOAD_STATUS" : "PW_NETWORK_REFUSED")) }
        #expect(calls.withLock { $0 } == 1)
    }

    /// The resolved public address is the connection endpoint; the original host remains the TLS identity.
    @Test func publicResolutionPinsAddressWithoutReplacingTLSHostname() async throws {
        let seen = Mutex<[NativeDownloadRequest]>([])
        let download = NativePublicDownload(resolver: { _, _ in ["8.8.8.8", "1.1.1.1"] }, transport: { request in
            seen.withLock { $0.append(request) }
            return NativeHTTPReply(status: 200, headers: [:], body: Data("png".utf8))
        })
        let result = try await download.fetch("https://images.example/frame.png", deadline: Self.deadline)
        #expect(result == Data("png".utf8))
        #expect(seen.withLock { $0.first?.address } == "8.8.8.8")
        #expect(seen.withLock { $0.first?.hostname } == "images.example")
        #expect(seen.withLock { $0.first?.url.host } == "images.example")
    }

    /// One unsafe DNS result refuses the whole set, not just a preferred safe answer.
    @Test func mixedDNSAndPrivateLiteralNeverReachTransport() async throws {
        let calls = Mutex(0)
        let download = NativePublicDownload(resolver: { _, _ in ["8.8.8.8", "127.0.0.1"] }, transport: { _ in
            calls.withLock { $0 += 1 }
            return NativeHTTPReply(status: 200, headers: [:], body: Data())
        })
        for url in ["https://images.example/a", "https://10.0.0.1/a", "https://[::ffff:127.0.0.1]/a", "https://[64:ff9b::7f00:1]/a", "http://8.8.8.8/a"] {
            await #expect(throws: HostFailure.self) { try await download.fetch(url, deadline: Self.deadline) }
        }
        #expect(calls.withLock { $0 } == 0)
    }

    /// Direct, all-reserved DNS, mixed-DNS and redirected special-use or reserved-unicast
    /// targets share the same refusal code before connecting.
    @Test func specialUseTargetsNeverReachAnotherTransportHop() async throws {
        for address in ["198.18.0.1", "240.0.0.1", "2001:db8::1", "::ffff:198.18.0.1",
                        "3ffe::1", "3000::1", "3fff:1000::1", "2001:1000::1"] {
            let calls = Mutex(0)
            let host = address.contains(":") ? "[\(address)]" : address
            let mixed = NativePublicDownload(resolver: { _, _ in ["8.8.8.8", address] }, transport: { _ in
                calls.withLock { $0 += 1 }
                return NativeHTTPReply(status: 200, headers: [:], body: Data([1]))
            })
            for url in ["https://images.example/a", "https://\(host)/a"] {
                do {
                    _ = try await mixed.fetch(url, deadline: Self.deadline)
                    Issue.record("Special-use destination returned media: \(address)")
                } catch let error as HostFailure { #expect(error.code == "PW_NETWORK_REFUSED") }
            }
            #expect(calls.withLock { $0 } == 0)
            let reservedOnly = NativePublicDownload(resolver: { _, _ in [address] }, transport: { _ in
                calls.withLock { $0 += 1 }
                return NativeHTTPReply(status: 200, headers: [:], body: Data([1]))
            })
            do {
                _ = try await reservedOnly.fetch("https://images.example/a", deadline: Self.deadline)
                Issue.record("Reserved-only DNS returned media: \(address)")
            } catch let error as HostFailure { #expect(error.code == "PW_NETWORK_REFUSED") }
            #expect(calls.withLock { $0 } == 0)
            let redirect = NativePublicDownload(resolver: { _, _ in ["8.8.8.8"] }, transport: { _ in
                calls.withLock { $0 += 1 }
                return NativeHTTPReply(status: 302, headers: ["location": "https://\(host)/a"], body: Data())
            })
            do {
                _ = try await redirect.fetch("https://images.example/a", deadline: Self.deadline)
                Issue.record("Special-use redirect returned media: \(address)")
            } catch let error as HostFailure { #expect(error.code == "PW_NETWORK_REFUSED") }
            #expect(calls.withLock { $0 } == 1)
        }
    }

    /// Redirects re-enter DNS validation before another connection and cannot cross to an internal target.
    @Test func redirectRevalidatesAllAnswersAndStopsPrivateTarget() async throws {
        let calls = Mutex(0)
        let download = NativePublicDownload(resolver: { host, _ in host == "images.example" ? ["8.8.8.8"] : ["192.168.1.1"] }, transport: { _ in
            calls.withLock { $0 += 1 }
            return NativeHTTPReply(status: 302, headers: ["location": "https://private.example/a"], body: Data())
        })
        await #expect(throws: HostFailure.self) { try await download.fetch("https://images.example/a", deadline: Self.deadline) }
        #expect(calls.withLock { $0 } == 1)
    }

    /// Relative redirects retain the original identity while the existing five-hop ceiling stays bounded.
    @Test func relativeRedirectSucceedsAndCycleIsBounded() async throws {
        let paths = Mutex<[String]>([])
        let download = NativePublicDownload(resolver: { _, _ in ["8.8.8.8"] }, transport: { request in
            paths.withLock { $0.append(request.url.path) }
            return request.url.path == "/a" ? NativeHTTPReply(status: 302, headers: ["location": "/b"], body: Data()) : NativeHTTPReply(status: 200, headers: [:], body: Data([1]))
        })
        #expect(try await download.fetch("https://images.example/a", deadline: Self.deadline) == Data([1]))
        #expect(paths.withLock { $0 } == ["/a", "/b"])
        let calls = Mutex(0)
        let loop = NativePublicDownload(resolver: { _, _ in ["8.8.8.8"] }, transport: { _ in
            calls.withLock { $0 += 1 }
            return NativeHTTPReply(status: 302, headers: ["location": "/a"], body: Data())
        })
        await #expect(throws: HostFailure.self) { try await loop.fetch("https://images.example/a", deadline: Self.deadline) }
        #expect(calls.withLock { $0 } == 6)
    }

    /// Cancelled, expired and oversized work cannot return a successful body to an image writer.
    @Test func cancellationDeadlineAndBodyLimitReject() async throws {
        let calls = Mutex(0)
        let download = NativePublicDownload(resolver: { _, _ in ["8.8.8.8"] }, transport: { _ in
            calls.withLock { $0 += 1 }
            return NativeHTTPReply(status: 200, headers: [:], body: Data(repeating: 0, count: 5))
        }, maximum: 4)
        await #expect(throws: HostFailure.self) { try await download.fetch("https://images.example/a", deadline: Self.deadline, isCancelled: { true }) }
        await #expect(throws: HostFailure.self) { try await download.fetch("https://images.example/a", deadline: .now.advanced(by: .seconds(-1))) }
        #expect(calls.withLock { $0 } == 0)
        await #expect(throws: HostFailure.self) { try await download.fetch("https://images.example/a", deadline: Self.deadline) }
        let slow = NativePublicDownload(resolver: { _, _ in try await Task.sleep(for: .seconds(10)); return ["8.8.8.8"] }, transport: download.transport)
        let start = ContinuousClock.now
        await #expect(throws: HostFailure.self) { try await slow.fetch("https://images.example/a", deadline: .now.advanced(by: .milliseconds(20))) }
        #expect(start.duration(to: .now) < .seconds(1))
    }

    /// All non-2xx replies remain visible errors rather than becoming invalid generated files.
    @Test func responseFailureAndMissingRedirectLocationReject() async throws {
        for status in [302, 403] {
            let download = NativePublicDownload(resolver: { _, _ in ["8.8.8.8"] }, transport: { _ in NativeHTTPReply(status: status, headers: [:], body: Data()) })
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
