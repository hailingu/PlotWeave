import Foundation

/// Sendable JSON boundary value; business documents remain owned by the Web session.
indirect enum HostJSON: Codable, Sendable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([HostJSON])
    case object([String: HostJSON])

    /// Owner decision (issue #840, 2026-10-25): acceptance boundary for JSON nesting depth. Real documents nest
    /// under 20 levels across the Web, Rust and Swift encoders; 32 keeps headroom while staying far inside the
    /// crash zone of recursive decoding on a 512 KiB cooperative-thread stack (≈ 400 levels Release, ≈ 256 Debug).
    static let maxNestingDepth = 32
    /// Machine-readable failure code for documents nesting deeper than `maxNestingDepth` (issue #840).
    static let depthLimitCode = "PW_JSON_DEPTH_LIMIT"

    /// Codable entry kept for nested conformance and as the fallback authority behind `decode`. Probing each
    /// scalar type in turn makes Foundation throw once per mismatch, so this path runs near 47 MiB/s; callers
    /// holding raw bytes use `decode`, which only returns to this path for input the strict parser declines.
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([HostJSON].self) { self = .array(value) }
        else { self = .object(try container.decode([String: HostJSON].self)) }
    }

    /// Decodes wire bytes with Codable's acceptance set except for one owner-approved narrowing (issue #840):
    /// documents nesting deeper than `maxNestingDepth` are rejected up front, before any recursive decode can
    /// exhaust a 512 KiB cooperative-thread stack. `HostJSONParser` handles canonical UTF-8 documents directly
    /// (issue #825); everything it declines — exotic encodings, Foundation's leniencies, unrepresentable
    /// numbers, malformed input — passes the depth pre-scan and is decided by Codable, so a corrupt file still
    /// surfaces Foundation's diagnostic.
    static func decode(_ data: Data) throws -> HostJSON {
        if let value = HostJSONParser.parse(data) { return value }
        try Self.rejectNestingBeyondLimit(data)
        return try JSONDecoder().decode(HostJSON.self, from: data)
    }

    /// Iterative depth pre-scan for the fallback path (issue #840): counts brackets only outside strings, so it
    /// uses constant stack regardless of input. Exact for UTF-8, where quotes, escapes and structural bytes are
    /// unambiguous; a crafted document in an exotic multi-byte encoding whose string bytes collide with
    /// structural ASCII could still be miscounted — a recorded boundary outside the local single-user threat
    /// model, with Foundation's own 512-level scan limit as the remaining backstop.
    private static func rejectNestingBeyondLimit(_ data: Data) throws {
        var depth = 0
        var insideString = false
        var escaped = false
        for byte in data {
            if insideString {
                if escaped { escaped = false }
                else if byte == 0x5C { escaped = true }
                else if byte == 0x22 { insideString = false }
                continue
            }
            switch byte {
            case 0x22: insideString = true
            case 0x5B, 0x7B:
                depth += 1
                guard depth <= maxNestingDepth else {
                    throw HostFailure(code: depthLimitCode, message: "JSON 嵌套深度超过 \(maxNestingDepth) 层上限，拒绝解码")
                }
            case 0x5D, 0x7D: if depth > 0 { depth -= 1 }
            default: break
            }
        }
    }

    /// Encodes the same JSON shape for Rust and WebKit consumers.
    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }

    /// Creates a JSON value at the WebKit boundary, rejecting non-JSON payloads. Serialization keeps Foundation's
    /// validation of the untyped tree (non-string keys, NaN, dates); the bytes are then decoded without moving
    /// those untyped objects between actors.
    init(webValue: Any) throws {
        let data = try JSONSerialization.data(withJSONObject: webValue, options: [.fragmentsAllowed])
        self = try Self.decode(data)
    }

    /// Converts into the WebKit reply API's supported Foundation values on its caller's actor.
    var webValue: Any {
        switch self {
        case .null: return NSNull()
        case .bool(let value): return value
        case .number(let value): return value
        case .string(let value): return value
        case .array(let value): return value.map(\.webValue)
        case .object(let value): return value.mapValues(\.webValue)
        }
    }

    /// Reads only object members; absent or differently typed members stay absent.
    subscript(key: String) -> HostJSON? {
        guard case .object(let object) = self else { return nil }
        return object[key]
    }

    /// Exposes object fields without coercing invalid containers into empty document buckets.
    var object: [String: HostJSON]? {
        guard case .object(let value) = self else { return nil }
        return value
    }

    /// Exposes array elements while preserving the distinction between absent, null and empty lists.
    var arrayValue: [HostJSON]? {
        guard case .array(let value) = self else { return nil }
        return value
    }

    /// Returns a string member without coercing input from other JSON types.
    var string: String? {
        guard case .string(let value) = self else { return nil }
        return value
    }
}

/// Structured bridge failure; domain messages remain intact for the existing UI decoder.
struct HostFailure: Error, Sendable {
    let code: String
    let message: String

    /// Router and project dispatch share the existing unknown-host failure without duplicating its text.
    static func commandUnavailable(_ command: String) -> HostFailure {
        HostFailure(code: "PW_HOST_COMMAND_UNAVAILABLE", message: "宿主命令尚未接通：\(command)")
    }

    /// JSON wire reply required by protocol version 1.
    var reply: HostJSON {
        .object(["error": .object(["code": .string(code), "message": .string(message)])])
    }
}
