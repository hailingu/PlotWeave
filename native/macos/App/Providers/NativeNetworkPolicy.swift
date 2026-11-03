import Darwin
import Foundation

/// URL and literal-IP policy is shared by provider redirects and the stricter image download boundary.
enum NativeNetworkPolicy {
    /// The OpenAI-compatible transport retains HTTPS everywhere and HTTP only for explicit loopback hosts.
    static func provider(_ url: URL, secureSeen: Bool = false) throws {
        guard let scheme = url.scheme?.lowercased(), let host = url.host, !host.isEmpty else { throw refused("服务地址必须是有效的 HTTP 或 HTTPS URL") }
        if scheme == "https" { return }
        if scheme == "http", !secureSeen, isLoopback(host) { return }
        if scheme == "http", secureSeen { throw refused("服务重定向不能从 HTTPS 降级到 HTTP") }
        throw refused("远程服务必须使用 HTTPS；HTTP 仅允许显式回环地址")
    }

    /// The approved native downloader accepts only HTTPS and does not send embedded URL credentials.
    static func download(_ url: URL) throws -> (String, UInt16) {
        guard url.scheme?.lowercased() == "https", let raw = url.host, !raw.isEmpty,
              url.user == nil, url.password == nil, (1...65_535).contains(url.port ?? 443) else {
            throw refused("图像下载必须使用无内嵌凭据的有效 HTTPS URL")
        }
        return (stripBrackets(raw), UInt16(url.port ?? 443))
    }

    /// All answers must satisfy the existing public-IP contract, including embedded IPv4 transition forms.
    static func isPublic(_ text: String) -> Bool {
        let host = stripBrackets(text)
        if let bytes = ipv4(host) { return publicV4(bytes) }
        guard let bytes = ipv6(host) else { return false }
        if bytes.prefix(12).allSatisfy({ $0 == 0 }) { return publicV4(Array(bytes.suffix(4))) }
        if bytes.prefix(10).allSatisfy({ $0 == 0 }), bytes[10] == 255, bytes[11] == 255 { return publicV4(Array(bytes.suffix(4))) }
        if bytes[0] == 0x20, bytes[1] == 0x02 { return publicV4(Array(bytes[2..<6])) }
        if Array(bytes.prefix(12)) == [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0] { return publicV4(Array(bytes.suffix(4))) }
        if bytes[8] & 0xfd == 0, bytes[9] == 0, bytes[10] == 0x5e, bytes[11] == 0xfe,
           !publicV4(Array(bytes.suffix(4))) { return false }
        return publicV6(bytes)
    }

    /// Literal classification bypasses DNS entirely, preventing accidental hostname reinterpretation.
    static func isLiteral(_ host: String) -> Bool { ipv4(stripBrackets(host)) != nil || ipv6(stripBrackets(host)) != nil }

    /// Authorization must be removed whenever the host or effective port changes on a redirect.
    static func sameOrigin(_ a: URL, _ b: URL) -> Bool {
        a.host?.lowercased() == b.host?.lowercased() && effectivePort(a) == effectivePort(b)
    }

    /// Explicit loopback never relies on DNS resolving a custom remote-looking hostname.
    private static func isLoopback(_ raw: String) -> Bool {
        let host = stripBrackets(raw).lowercased()
        if host == "localhost" { return true }
        if let bytes = ipv4(host) { return bytes[0] == 127 }
        return ipv6(host) == [UInt8](repeating: 0, count: 15) + [1]
    }

    /// IANA non-global, deprecated and multicast ranges cannot be pinned image-download destinations.
    private static func publicV4(_ b: [UInt8]) -> Bool {
        if b[0] == 0 || b[0] == 10 || b[0] == 127 || b[0] >= 224 { return false }
        if b[0] == 172, (16...31).contains(b[1]) { return false }
        if b[0] == 192, b[1] == 168 { return false }
        if b[0] == 169, b[1] == 254 { return false }
        if b[0] == 100, (64...127).contains(b[1]) { return false }
        if b[0] == 192, b[1] == 0, b[2] == 0 { return b[3] == 9 || b[3] == 10 }
        if b[0] == 192, (b[1] == 0 && b[2] == 2) || (b[1] == 88 && b[2] == 99) { return false }
        if b[0] == 198, (18...19).contains(b[1]) || (b[1] == 51 && b[2] == 100) { return false }
        return !(b[0] == 203 && b[1] == 0 && b[2] == 113)
    }

    /// Ordinary IPv6 qualifies only inside IANA-allocated global unicast prefixes or the
    /// registry's globally reachable `2001::/23` exceptions; nominal `2000::/3` membership
    /// alone never authorizes a pinned download endpoint (issue #528).
    private static func publicV6(_ b: [UInt8]) -> Bool {
        guard b[0] & 0xe0 == 0x20 else { return false }
        // 2001:db8::/32 documentation is carved out of the allocated 2001:0c00::/23 registry row.
        if b[0] == 0x20, b[1] == 0x01, b[2] == 0x0d, b[3] == 0xb8 { return false }
        return globalV6Rows.contains { within(b, $0) }
    }

    /// Registry rows that may receive pinned downloads: every ALLOCATED prefix of the IANA
    /// IPv6 Global Unicast registry (page dated 2025-10-10) plus its globally reachable
    /// exceptions carved inside the IETF `2001::/23` protocol space (special-purpose
    /// registry). Space of the aggregate `2000::/3` that the registries do not list —
    /// including `2d00::/8`, `2e00::/7`, `3ffe::/16` and the unallocated `2001::/16` gaps —
    /// is reserved for future allocation and therefore absent here by design; new registry
    /// allocations require updating this table and its boundary regression together.
    private static let globalV6Rows: [(prefix: [UInt8], bits: Int)] = [
        ([0x20, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01], 128),  // 2001:1::1/128 PCP anycast
        ([0x20, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02], 128),  // 2001:1::2/128 TURN anycast
        ([0x20, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03], 128),  // 2001:1::3/128 DNS-SD anycast
        ([0x20, 0x01, 0x00, 0x03], 32),                   // 2001:3::/32 AMT anycast
        ([0x20, 0x01, 0x00, 0x04, 0x01, 0x12], 48),       // 2001:4:112::/48 AS112-v6
        ([0x20, 0x01, 0x00, 0x20], 28),                   // 2001:20::/28 ORCHIDv2
        ([0x20, 0x01, 0x00, 0x30], 28),                   // 2001:30::/28 drone remote ID
        ([0x20, 0x01, 0x02, 0x00], 23),                   // 2001:0200::/23 APNIC
        ([0x20, 0x01, 0x04, 0x00], 23),                   // 2001:0400::/23 ARIN
        ([0x20, 0x01, 0x06, 0x00], 23),                   // 2001:0600::/23 RIPE NCC
        ([0x20, 0x01, 0x08, 0x00], 22),                   // 2001:0800::/22 RIPE NCC
        ([0x20, 0x01, 0x0c, 0x00], 23),                   // 2001:0c00::/23 APNIC (minus documentation)
        ([0x20, 0x01, 0x0e, 0x00], 23),                   // 2001:0e00::/23 APNIC
        ([0x20, 0x01, 0x12, 0x00], 23),                   // 2001:1200::/23 LACNIC
        ([0x20, 0x01, 0x14, 0x00], 22),                   // 2001:1400::/22 RIPE NCC
        ([0x20, 0x01, 0x18, 0x00], 23),                   // 2001:1800::/23 ARIN
        ([0x20, 0x01, 0x1a, 0x00], 23),                   // 2001:1a00::/23 RIPE NCC
        ([0x20, 0x01, 0x1c, 0x00], 22),                   // 2001:1c00::/22 RIPE NCC
        ([0x20, 0x01, 0x20, 0x00], 19),                   // 2001:2000::/19 RIPE NCC
        ([0x20, 0x01, 0x40, 0x00], 23),                   // 2001:4000::/23 RIPE NCC
        ([0x20, 0x01, 0x42, 0x00], 23),                   // 2001:4200::/23 AFRINIC
        ([0x20, 0x01, 0x44, 0x00], 23),                   // 2001:4400::/23 APNIC
        ([0x20, 0x01, 0x46, 0x00], 23),                   // 2001:4600::/23 RIPE NCC
        ([0x20, 0x01, 0x48, 0x00], 23),                   // 2001:4800::/23 ARIN
        ([0x20, 0x01, 0x4a, 0x00], 23),                   // 2001:4a00::/23 RIPE NCC
        ([0x20, 0x01, 0x4c, 0x00], 23),                   // 2001:4c00::/23 RIPE NCC
        ([0x20, 0x01, 0x50, 0x00], 20),                   // 2001:5000::/20 RIPE NCC
        ([0x20, 0x01, 0x80, 0x00], 19),                   // 2001:8000::/19 APNIC
        ([0x20, 0x01, 0xa0, 0x00], 20),                   // 2001:a000::/20 APNIC
        ([0x20, 0x01, 0xb0, 0x00], 20),                   // 2001:b000::/20 APNIC
        ([0x20, 0x03, 0x00], 18),                         // 2003::/18 RIPE NCC
        ([0x24, 0x00], 12),                               // 2400::/12 APNIC (2400–240f)
        ([0x24, 0x10, 0x00], 12),                         // 2410::/12 APNIC (2410–241f)
        ([0x26, 0x00], 12),                               // 2600::/12 ARIN (2600–260f)
        ([0x26, 0x10, 0x00], 23),                         // 2610::/23 ARIN
        ([0x26, 0x20, 0x00], 23),                         // 2620::/23 ARIN
        ([0x26, 0x30, 0x00], 12),                         // 2630::/12 ARIN (2630–263f)
        ([0x28, 0x00], 12),                               // 2800::/12 LACNIC (2800–280f)
        ([0x2a, 0x00], 12),                               // 2a00::/12 RIPE NCC (2a00–2a0f)
        ([0x2a, 0x10, 0x00], 12),                         // 2a10::/12 RIPE NCC (2a10–2a1f)
        ([0x2c, 0x00], 12)                                // 2c00::/12 AFRINIC (2c00–2c0f)
    ]

    /// A row matches when its whole leading bytes equal the address and the boundary byte
    /// agrees on its significant high bits, mirroring CIDR prefix containment.
    private static func within(_ address: [UInt8], _ row: (prefix: [UInt8], bits: Int)) -> Bool {
        let whole = row.bits / 8
        guard address.prefix(whole).elementsEqual(row.prefix.prefix(whole)) else { return false }
        let remainder = row.bits % 8
        guard remainder > 0 else { return true }
        return address[whole] >> (8 - remainder) == row.prefix[whole] >> (8 - remainder)
    }

    /// Network-order bytes avoid signed integer/endian ambiguity in subnet comparisons.
    private static func ipv4(_ text: String) -> [UInt8]? {
        var address = in_addr()
        guard text.withCString({ inet_pton(AF_INET, $0, &address) }) == 1 else { return nil }
        return withUnsafeBytes(of: address) { Array($0) }
    }

    /// IPv6 transitions are inspected as their sixteen network-order bytes.
    private static func ipv6(_ text: String) -> [UInt8]? {
        var address = in6_addr()
        guard text.withCString({ inet_pton(AF_INET6, $0, &address) }) == 1 else { return nil }
        return withUnsafeBytes(of: address) { Array($0) }
    }

    /// Foundation includes brackets in some IPv6 host projections; wire identity excludes them.
    private static func stripBrackets(_ value: String) -> String { value.hasPrefix("[") && value.hasSuffix("]") ? String(value.dropFirst().dropLast()) : value }
    /// Origin comparison uses each scheme's effective default port.
    private static func effectivePort(_ value: URL) -> Int { value.port ?? (value.scheme?.lowercased() == "https" ? 443 : 80) }
    /// Policy diagnostics never include the original URL, query or credential fields.
    static func refused(_ message: String) -> HostFailure { HostFailure(code: "PW_NETWORK_REFUSED", message: message) }
}
