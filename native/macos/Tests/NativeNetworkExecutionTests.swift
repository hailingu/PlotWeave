import Foundation
import Network
import Testing
@testable import PlotWeaveNative

/// Existing low-level production APIs must validate numeric destinations without public network traffic.
@Suite(.serialized)
struct NativeNetworkExecutionTests {
    /// Real getaddrinfo/getnameinfo execute on numeric input; no external DNS service is contacted.
    @Test(arguments: ["127.0.0.1", "2606:4700:4700::1111"])
    func systemNumericResolutionRetainsAddressIdentity(_ hostname: String) async throws {
        let values = try await NativePublicDNS.resolve(hostname, deadline: .now.advanced(by: .seconds(2)))
        #expect(!values.isEmpty)
        #expect(values.allSatisfy(NativeNetworkPolicy.isLiteral))
        #expect(values.allSatisfy { NWEndpoint.Host($0) == NWEndpoint.Host(hostname) })
        #expect(values.allSatisfy { NativeNetworkPolicy.isPublic($0) == NativeNetworkPolicy.isPublic(hostname) })
    }

    /// A hostname can identify TLS/HTTP, but it cannot become a second resolver input at connection time.
    @Test func pinnedTransportRejectsNonNumericConnectionInput() async throws {
        let url = try #require(URL(string: "https://fixture.invalid/image.png?fixture=only"))
        let request = NativeDownloadRequest(url: url, address: "fixture.invalid", hostname: "fixture.invalid",
                                            port: 443, deadline: .now.advanced(by: .seconds(2)), maximum: 32)
        do {
            _ = try await NativePinnedHTTP.perform(request)
            Issue.record("A nonnumeric transport destination was accepted")
        } catch let failure as HostFailure {
            #expect(failure.code == "PW_NETWORK_REFUSED")
            #expect(!failure.message.contains("fixture=only"))
        }
    }
}
