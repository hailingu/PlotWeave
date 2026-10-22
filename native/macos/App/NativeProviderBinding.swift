import Foundation

/// A credential is bound to a destination taken from the same persisted provider snapshot.
struct NativeProviderCredential: Sendable {
    /// Only the backend-selected endpoint may carry the decrypted key.
    let url: URL
    /// Plaintext is transient and never serialized or projected to the page.
    let key: String
}

/// IPC keeps its existing baseUrl field, but it cannot select a destination independently of settings.
enum NativeProviderBinding {
    /// Canonical equality permits host case, default ports and trailing slashes without broadening paths.
    static func endpoint(configured: String, requested: String, suffix: String) throws -> URL {
        guard try canonical(configured) == canonical(requested) else {
            throw NativeNetworkPolicy.refused("服务地址与已保存的 provider 配置不一致，请重新加载设置")
        }
        return try url(configured, suffix: suffix)
    }

    /// Scheme/host are case-insensitive and default ports have one identity; query/path remain significant.
    private static func canonical(_ base: String) throws -> String {
        let endpoint = try url(base, suffix: "")
        guard var parts = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else {
            throw NativeNetworkPolicy.refused("服务地址必须是有效的 HTTP 或 HTTPS URL")
        }
        parts.scheme = parts.scheme?.lowercased()
        parts.host = parts.host?.lowercased()
        if parts.port == (parts.scheme == "https" ? 443 : 80) { parts.port = nil }
        guard let identity = parts.string else {
            throw NativeNetworkPolicy.refused("服务地址必须是有效的 HTTP 或 HTTPS URL")
        }
        return identity
    }

    /// Preserve existing endpoint concatenation and provider-local HTTP support before any key is opened.
    private static func url(_ base: String, suffix: String) throws -> URL {
        var value = base
        while value.hasSuffix("/") { value.removeLast() }
        guard let url = URL(string: value + "/" + suffix) else {
            throw NativeNetworkPolicy.refused("服务地址必须是有效的 HTTP 或 HTTPS URL")
        }
        try NativeNetworkPolicy.provider(url)
        return url
    }
}
