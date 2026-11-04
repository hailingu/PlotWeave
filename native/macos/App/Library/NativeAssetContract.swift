import Foundation

/// Shared native AssetRef leaf policy: paths, concrete MIME and canonical UTC never depend on a host framework.
enum NativeAssetContract {
    /// Lexical paths are relative to assets; load verification separately reports reserved quarantine references.
    static func lexicalRelPath(_ path: String) -> Bool {
        guard path == path.trimmingCharacters(in: .whitespacesAndNewlines), !path.contains("\\"), !path.contains("\0") else { return false }
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        return parts.count >= 2 && parts.first == "assets" && parts.allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }
    }

    /// Only active assets-relative paths are valid; the reserved quarantine tree is never addressable.
    static func activeRelPath(_ path: String) -> Bool {
        lexicalRelPath(path) && !path.split(separator: "/").contains(".trash")
    }

    /// RFC token characters form exactly one specific type/subtype, without wildcards, parameters or uppercase.
    static func mime(_ value: String) -> Bool {
        let parts = value.split(separator: "/", omittingEmptySubsequences: false)
        let allowed = Set("!#$%&'+-.^_`|~".utf8)
        return parts.count == 2 && parts.allSatisfy { part in
            !part.isEmpty && part.utf8.allSatisfy { (97...122).contains($0) || (48...57).contains($0) || allowed.contains($0) }
        }
    }

    /// Canonical timestamps match the persisted toISOString shape and resolve to the same UTC instant.
    static func canonicalUTC(_ value: String) -> Bool { normalizedTimestamp(value) == value }

    /// Read normalization accepts explicit UTC offsets, while rejecting timezone-free and unsupported year shapes.
    static func normalizedTimestamp(_ value: String) -> String? { NativeTimestampParsing.normalizedTimestamp(value) }

    /// Newly materialized native assets always use explicit UTC milliseconds.
    static func timestamp(_ date: Date = Date()) -> String { NativeTimestampParsing.canonicalTimestamp(date) }

    /// Internal library callers use the same path rule rather than maintaining a second lexical grammar.
    static func validPath(_ value: String) -> Bool { activeRelPath(value) }
    /// Internal library callers use the same MIME rule after their documented normalization step.
    static func validMIME(_ value: String) -> Bool { mime(value) }

    /// Import preserves a safe filename extension; generated assets use the existing narrower MIME mapping.
    static func fileExtension(name: String, mime: String, generated: Bool = false) -> String {
        if !generated, let suffix = name.split(separator: ".", omittingEmptySubsequences: false).last,
           name.contains("."), !suffix.isEmpty, suffix.utf8.count <= 8,
           suffix.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) }) { return suffix.lowercased() }
        switch mime {
        case "image/png": return "png"
        case "image/jpeg": return "jpg"
        case "image/webp": return "webp"
        case "image/gif": return "gif"
        case "image/avif" where !generated: return "avif"
        default: return "bin"
        }
    }
}
