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
        if Array(bytes.prefix(6)) == [0x00, 0x64, 0xff, 0x9b, 0, 1] { return false }
        if bytes[0] == 0xff || bytes[0] & 0xfe == 0xfc { return false }
        if bytes[0] == 0xfe, (bytes[1] & 0xc0 == 0x80 || bytes[1] & 0xc0 == 0xc0) { return false }
        return true
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

    /// IPv4 public exclusions match the existing generated-image URL contract.
    private static func publicV4(_ b: [UInt8]) -> Bool {
        if b[0] == 0 || b[0] == 10 || b[0] == 127 || (224...239).contains(b[0]) { return false }
        if b[0] == 172, (16...31).contains(b[1]) { return false }
        if b[0] == 192, b[1] == 168 { return false }
        if b[0] == 169, b[1] == 254 { return false }
        if b[0] == 100, (64...127).contains(b[1]) { return false }
        return b != [255, 255, 255, 255]
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
