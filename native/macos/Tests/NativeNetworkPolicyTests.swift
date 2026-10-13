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
    /// Reserved and unallocated rows inside nominal `2000::/3` (issue #528) refuse just like
    /// space outside it: registry membership, not the aggregate prefix, decides.
    @Test func nonGlobalIPv6IsRefused() {
        for address in ["::", "::1", "100::1", "100:0:0:1::1", "64:ff9b:1::808:808",
                        "2001::1", "2001:2::1", "2001:10::1", "2001:db8::1", "3fff::1",
                        "3fff:fff:ffff::1", "5f00::1", "fc00::1", "fe80::1", "fec0::1",
                        "ff02::1", "4000::1", "invalid",
                        "3ffe::1", "3fff:1000::1", "2d00::1", "2e00::1", "3000::1", "3800::1",
                        "2001:1000::1", "2001:4e00::1", "2001:6000::1", "2001:c000::1"] {
            #expect(!NativeNetworkPolicy.isPublic(address), "Refuse \(address)")
        }
    }

    /// Allocated prefixes qualify end to end while the reserved registry gaps around them refuse.
    /// Boundaries mirror the IANA IPv6 Global Unicast registry (page dated 2025-10-10) and its
    /// globally reachable `2001::/23` exceptions, checked 2026-10-13 (issue #528).
    @Test func allocatedPrefixBoundariesFollowIanaRegistry() {
        let allocated = [
            "2001:200::1", "2001:3ff:ffff:ffff:ffff:ffff:ffff:ffff",  // 2001:0200::/23 APNIC
            "2001:800::1", "2001:bff:ffff::1",                        // 2001:0800::/22 RIPE NCC
            "2001:fff:ffff::1",                                        // 2001:0e00::/23 APNIC end
            "2001:1200::1",                                            // 2001:1200::/23 LACNIC
            "2001:1fff:ffff::1",                                       // 2001:1c00::/22 RIPE NCC end
            "2001:2000::1", "2001:3fff:ffff:ffff:ffff:ffff:ffff:ffff", // 2001:2000::/19 RIPE NCC
            "2001:4dff:ffff::1",                                       // 2001:4c00::/23 RIPE NCC end
            "2001:5000::1", "2001:5fff:ffff::1",                      // 2001:5000::/20 RIPE NCC
            "2001:8000::1", "2001:9fff:ffff::1",                      // 2001:8000::/19 APNIC
            "2001:a000::1",                                            // 2001:a000::/20 APNIC
            "2001:b000::1", "2001:bfff:ffff::1",                      // 2001:b000::/20 APNIC
            "2001:db7:ffff::1", "2001:db9::1",                        // 2001:db8::/32 carve-out adjacency
            "2003::1", "2003:3fff:ffff::1",                            // 2003::/18 RIPE NCC
            "2400::1", "240f:ffff::1",                                 // 2400::/12 APNIC (2400–240f)
            "2410::1", "241f:ffff::1",                                 // 2410::/12 APNIC (2410–241f)
            "2600::1", "260f:ffff::1",                                 // 2600::/12 ARIN (2600–260f)
            "2610::1", "2610:1ff:ffff::1",                             // 2610::/23 ARIN
            "2620::1", "2620:1ff:ffff::1",                             // 2620::/23 ARIN
            "2630::1", "263f:ffff::1",                                 // 2630::/12 ARIN (2630–263f)
            "2800::1", "280f:ffff::1",                                 // 2800::/12 LACNIC (2800–280f)
            "2a00::1", "2a0f:ffff::1",                                 // 2a00::/12 RIPE NCC (2a00–2a0f)
            "2a10::1", "2a1f:ffff::1",                                 // 2a10::/12 RIPE NCC (2a10–2a1f)
            "2c00::1", "2c0f:ffff::1"                                  // 2c00::/12 AFRINIC (2c00–2c0f)
        ]
        let reserved = [
            "2001:1ff:ffff::1",                                        // unlisted IETF 2001::/23 tail
            "2001:1000::1", "2001:11ff:ffff::1",                       // gap 2001:1000::/23
            "2001:4e00::1", "2001:4fff:ffff::1",                       // gap 2001:4e00::/23
            "2001:6000::1", "2001:7fff:ffff::1",                       // gap 2001:6000::/22
            "2001:c000::1", "2001:ffff:ffff::1",                       // gap 2001:c000::/20
            "2003:4000::1", "2004::1",                                 // unallocated 2003::/16 tail
            "2500::1", "2700::1", "2900::1", "2b00::1",                // space between /12 allocations
            "2420::1", "24ff:ffff::1",                                 // beyond APNIC /12 pairs
            "2610:200::1", "2620:200::1", "2640::1", "26ff:ffff::1",   // beyond ARIN rows
            "2a20::1", "2aff:ffff::1",                                 // beyond RIPE /12 pairs
            "28ff:ffff::1", "2cff:ffff::1",                            // beyond LACNIC/AFRINIC /12
            "2d00::1", "2dff:ffff::1",                                 // 2d00::/8 RESERVED
            "2e00::1", "3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",      // 2e00::/7 RESERVED span
            "3000::1", "3800::1", "3e00::1",                           // listed RESERVED rows
            "3ffe::1", "3fff::1", "3fff:fff:ffff::1", "3fff:1000::1"   // 6bone, 3fff::/20 documentation, tail
        ]
        for address in allocated { #expect(NativeNetworkPolicy.isPublic(address), "Allow \(address)") }
        for address in reserved { #expect(!NativeNetworkPolicy.isPublic(address), "Refuse \(address)") }
    }

    /// Adjacent ordinary addresses and IANA globally reachable exceptions remain eligible without real connections.
    @Test func globalAddressesRemainEligible() {
        for address in ["8.8.8.8", "1.1.1.1", "100.63.255.255", "100.128.0.0", "172.15.255.255",
                        "172.32.0.0", "192.0.0.9", "192.0.0.10", "192.0.1.255", "192.0.3.0",
                        "198.17.255.255", "198.20.0.0", "223.255.255.255", "192.31.196.1",
                        "192.52.193.1", "192.175.48.1", "2606:4700:4700::1111", "2001:4860:4860::8888",
                        "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1",
                        "2001:1::1", "2001:1::2", "2001:1::3", "2001:3::1", "2001:4:112::1",
                        "2001:20::1", "2001:30::1", "2001:4860::200:5efe:808:808"] {
            #expect(NativeNetworkPolicy.isPublic(address), "Allow \(address)")
        }
    }
}
