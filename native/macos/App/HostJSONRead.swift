import Foundation

/// Typed read helpers for native presentation; absent values never become editable defaults.
extension HostJSON {
    /// Reads an array without coercing a malformed projection.
    var array: [HostJSON] {
        guard case .array(let values) = self else { return [] }
        return values
    }
    /// Reads a boolean without treating numbers or strings as flags.
    var bool: Bool? {
        guard case .bool(let value) = self else { return nil }
        return value
    }
    /// Reads a number only when finite, suitable for presentation and ordering.
    var number: Double? {
        guard case .number(let value) = self, value.isFinite else { return nil }
        return value
    }
}

/// Foundation's error conversion preserves the actionable bridge message without logging request payloads.
extension HostFailure: LocalizedError {
    /// The service owns the diagnostic text; native presentation uses the same contract as Web.
    var errorDescription: String? { message }
}

/// Required argument failures preserve each service's existing code, user-facing text and empty-string policy.
enum HostArgumentDomain: Sendable {
    case project, library, asset, model

    /// Project IPC historically treats empty strings as absent; the other domains validate them downstream.
    var rejectsEmptyString: Bool { self == .project }

    /// Domain diagnostics never echo caller values; project errors retain their trusted field name.
    func stringFailure(_ key: String) -> HostFailure {
        switch self {
        case .project: return NativeProjectEnvelope.invalid("缺少 \(key) 字段")
        case .library: return NativeLibraryIndex.invalid("缺少必填字段")
        case .asset: return NativeLibraryIndex.invalid("素材请求缺少必填字段")
        case .model: return HostFailure(code: "PW_MODEL_ERROR", message: "模型请求字符串参数缺失或类型错误")
        }
    }
}

/// IPC dictionaries share one strict scalar reader while domain-specific validation remains explicit.
extension Dictionary where Key == String, Value == HostJSON {
    /// Returns the original string without trimming or coercion, preserving the selected domain's empty policy.
    func requiredString(_ key: String, domain: HostArgumentDomain) throws -> String {
        guard let value = self[key]?.string, !domain.rejectsEmptyString || !value.isEmpty else {
            throw domain.stringFailure(key)
        }
        return value
    }
}
