import Foundation

/// Sendable JSON boundary value; business documents remain owned by the Web session.
indirect enum HostJSON: Codable, Sendable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([HostJSON])
    case object([String: HostJSON])

    /// Decodes JSON without moving Foundation's untyped objects between actors.
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([HostJSON].self) { self = .array(value) }
        else { self = .object(try container.decode([String: HostJSON].self)) }
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

    /// Creates a JSON value at the WebKit boundary, rejecting non-JSON payloads.
    init(webValue: Any) throws {
        let data = try JSONSerialization.data(withJSONObject: webValue, options: [.fragmentsAllowed])
        self = try JSONDecoder().decode(Self.self, from: data)
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

    /// JSON wire reply required by protocol version 1.
    var reply: HostJSON {
        .object(["error": .object(["code": .string(code), "message": .string(message)])])
    }
}
