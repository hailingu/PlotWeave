import Foundation

/// Cached ICU shape checks preserve timestamp acceptance without forced-try initialization (issue #858).
struct LegacyTimestampShapes {
    private let input: NSRegularExpression
    private let canonical: NSRegularExpression

    /// Invalid patterns produce a structured internal failure; defaults retain the historical ICU grammar.
    init(
        inputPattern: String = #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$"#,
        canonicalPattern: String = #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$"#
    ) throws(HostFailure) {
        do {
            input = try NSRegularExpression(pattern: inputPattern)
            canonical = try NSRegularExpression(pattern: canonicalPattern)
        } catch {
            throw HostFailure(code: "PW_TIMESTAMP_PATTERN_INVALID", message: "时间戳格式校验器初始化失败")
        }
    }

    /// Only historical regex-shaped input reaches the cached formatters.
    func matchesInput(_ value: String) -> Bool { matches(input, value) }

    /// Normalized output must retain the historical UTC millisecond shape.
    func matchesCanonical(_ value: String) -> Bool { matches(canonical, value) }

    /// ICU matching remains byte-for-byte equivalent, including Unicode digits and end-anchor behavior.
    private func matches(_ regex: NSRegularExpression, _ value: String) -> Bool {
        regex.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil
    }
}
