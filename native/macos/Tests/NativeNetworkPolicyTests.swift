import Foundation
import Testing
@testable import PlotWeaveNative

/// Special-use destinations cannot cross the native generated-image download boundary.
struct NativeNetworkPolicyTests {
    /// IANA non-global IPv4 ranges remain refused in every supported embedded representation.
    @Test func nonGlobalIPv4AndTransitionFormsAreRefused() throws {
        let addresses = [
            "0.0.0.0", "10.0.0.1", "100.64.0.0", "100.127.255.255", "127.0.0.1",
            "169.254.0.1", "172.16.0.0", "172.31.255.255", "192.0.0.0", "192.0.0.8",
            "192.0.0.11", "192.0.0.170", "192.0.0.255", "192.0.2.0", "192.0.2.255",
            "192.88.99.0", "192.88.99.2", "192.88.99.255", "192.168.1.1",
            "198.18.0.0", "198.19.255.255", "198.51.100.1", "203.0.113.1",
            "224.0.0.0", "239.255.255.255", "240.0.0.0", "255.255.255.254", "255.255.255.255"
        ]
        for address in addresses {
            let bytes = try address.split(separator: ".").map { try #require(UInt8($0)) }
            let high = String(UInt16(bytes[0]) << 8 | UInt16(bytes[1]), radix: 16)
            let low = String(UInt16(bytes[2]) << 8 | UInt16(bytes[3]), radix: 16)
            for form in [address, "::\(address)", "::ffff:\(address)", "64:ff9b::\(high):\(low)",
                         "2002:\(high):\(low)::1", "2001:4860::200:5efe:\(high):\(low)"] {
                #expect(!NativeNetworkPolicy.isPublic(form), "Refuse \(form)")
            }
        }
    }

    /// Unallocated, local, documentation and protocol-only IPv6 addresses cannot become pinned endpoints.
    @Test func nonGlobalIPv6IsRefused() {
        for address in ["::", "::1", "100::1", "100:0:0:1::1", "64:ff9b:1::808:808",
                        "2001::1", "2001:2::1", "2001:10::1", "2001:db8::1", "3fff::1",
                        "3fff:fff:ffff::1", "5f00::1", "fc00::1", "fe80::1", "fec0::1",
                        "ff02::1", "4000::1", "invalid"] {
            #expect(!NativeNetworkPolicy.isPublic(address), "Refuse \(address)")
        }
    }

    /// Adjacent ordinary addresses and IANA globally reachable exceptions remain eligible without real connections.
    @Test func globalAddressesRemainEligible() {
        for address in ["8.8.8.8", "1.1.1.1", "100.63.255.255", "100.128.0.0", "172.15.255.255",
                        "172.32.0.0", "192.0.0.9", "192.0.0.10", "192.0.1.255", "192.0.3.0",
                        "198.17.255.255", "198.20.0.0", "223.255.255.255", "192.31.196.1",
                        "192.52.193.1", "192.175.48.1", "2606:4700:4700::1111", "2001:4860:4860::8888",
                        "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1",
                        "2001:1::1", "2001:1::2", "2001:1::3", "2001:3::1", "2001:4:112::1",
                        "2001:20::1", "2001:30::1", "3fff:1000::1", "2001:4860::200:5efe:808:808"] {
            #expect(NativeNetworkPolicy.isPublic(address), "Allow \(address)")
        }
    }
}
