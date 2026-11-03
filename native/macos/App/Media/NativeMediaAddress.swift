import Foundation

/// Opaque media addresses encode logical scope and identity, never a host path or an AssetRef relPath.
enum NativeMediaAddress: Sendable, Equatable {
    case library(String)
    case project(String, String)

    /// Web scope objects admit only their declared keys before any domain I/O occurs.
    init(scope: HostJSON, assetId: String) throws {
        guard let fields = scope.object, let kind = fields["kind"]?.string else { throw Self.invalid() }
        switch kind {
        case "library":
            guard Set(fields.keys) == ["kind"], NativeLibraryIndex.validID(assetId) else { throw Self.invalid() }
            self = .library(assetId)
        case "project":
            guard Set(fields.keys) == ["kind", "projectId"], let projectId = fields["projectId"]?.string,
                  !assetId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw Self.invalid() }
            try NativeProjectEnvelope.validateID(projectId)
            self = .project(projectId, assetId)
        default: throw Self.invalid()
        }
    }

    /// Resource URI parsing preserves percent-encoded syntax so encoded library IDs cannot bypass their ASCII grammar.
    init(url: URL) throws {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.scheme == "pwmedia", components.host == "localhost", components.user == nil,
              components.password == nil, components.port == nil else { throw Self.invalid() }
        let parts = components.percentEncodedPath.split(separator: "/", omittingEmptySubsequences: false)
        if parts.count == 3, parts[0].isEmpty, parts[1] == "library", NativeLibraryIndex.validID(String(parts[2])) {
            self = .library(String(parts[2])); return
        }
        guard parts.count == 4, parts[0].isEmpty, parts[1] == "project" else { throw Self.invalid() }
        let projectId = String(parts[2])
        try NativeProjectEnvelope.validateID(projectId)
        let raw = Array(parts[3].utf8)
        guard !raw.isEmpty, raw.count.isMultiple(of: 2) else { throw Self.invalid() }
        var bytes: [UInt8] = []
        for offset in stride(from: 0, to: raw.count, by: 2) {
            guard let high = Self.hex(raw[offset]), let low = Self.hex(raw[offset + 1]) else { throw Self.invalid() }
            bytes.append(high * 16 + low)
        }
        guard let assetId = String(bytes: bytes, encoding: .utf8), !assetId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw Self.invalid() }
        self = .project(projectId, assetId)
    }

    /// Existing macOS pwmedia wire URLs are stable across the native service migration.
    var url: String {
        switch self {
        case .library(let id): return "pwmedia://localhost/library/" + id
        case .project(let project, let id): return "pwmedia://localhost/project/" + project + "/" + id.utf8.map { String(format: "%02x", $0) }.joined()
        }
    }

    /// Scope-specific byte budgets apply to the actual opened file, including reads after a URL was issued.
    var maximumBytes: Int {
        switch self { case .library: return NativeLibrary.maximumBytes; case .project: return 256 * 1024 * 1024 }
    }

    /// Hex decoding accepts the same upper/lower input grammar as the existing protocol and emits lowercase URLs.
    private static func hex(_ byte: UInt8) -> UInt8? {
        switch byte { case 48...57: return byte - 48; case 97...102: return byte - 87; case 65...70: return byte - 55; default: return nil }
    }

    /// Error text does not disclose raw request paths or filesystem state.
    private static func invalid() -> HostFailure { HostFailure(code: "PW_MEDIA_INVALID", message: "媒体请求无效") }
}
