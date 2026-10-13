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
