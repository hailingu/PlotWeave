import Foundation

/// Provider error excerpts redact credential and URL secrets before a bounded string reaches either UI.
enum NativeModelDiagnostic {
    /// Replacement occurs before truncation, so a token crossing the excerpt boundary cannot leak a prefix.
    static func excerpt(_ bytes: Data, key: String, url: URL) -> String {
        var text = String(decoding: bytes, as: UTF8.self)
        var secrets = [key, url.absoluteString]
        if let encoded = try? JSONEncoder().encode(key), let quoted = String(data: encoded, encoding: .utf8), quoted.count >= 2 {
            secrets.append(String(quoted.dropFirst().dropLast()))
        }
        if let components = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            secrets += [components.user, components.password, components.percentEncodedQuery, components.query, components.fragment].compactMap { $0 }
            secrets += (components.queryItems ?? []).compactMap(\.value)
        }
        for secret in secrets.sorted(by: { $0.count > $1.count }) where !secret.isEmpty {
            text = text.replacingOccurrences(of: secret, with: "[已隐藏]")
        }
        return String(text.prefix(500))
    }
}
