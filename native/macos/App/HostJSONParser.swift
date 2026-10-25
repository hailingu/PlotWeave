import Foundation

/// Strict RFC 8259 UTF-8 parser that builds `HostJSON` directly from bytes, replacing the Codable
/// per-type `try` cascade on the storage and WebKit hot paths (issue #825; ≈ 400 MiB/s against ≈ 47 MiB/s).
/// It is deliberately narrower than Foundation: anything it does not handle — a BOM or non-UTF-8 encoding,
/// trailing commas, duplicate keys, nesting beyond `maxDepth`, numbers that overflow or underflow `Double` —
/// yields `nil` so `HostJSON.decode` can hand the bytes to `JSONDecoder`, which stays the single authority on
/// acceptance and error text. Its one obligation is therefore: every document it does accept decodes to the
/// value Codable would produce, bit for bit (`HostJSONDecodeTests`).
struct HostJSONParser {
    /// Internal rejection marker; it never escapes `parse`, which reports every rejection as `nil`.
    private struct Rejected: Error {}

    /// Recursion ceiling for this descent. Real documents nest under 20 levels; 128 keeps the parser far inside
    /// a 512 KiB cooperative-thread stack in every build configuration (measured: the optimized parser survives
    /// 512 levels there, the debug build 256). Deeper input is Codable's decision — Foundation accepts 512.
    static let maxDepth = 128

    private let bytes: [UInt8]
    private var index = 0
    private var depth = 0

    /// Parses one complete JSON text (fragments included) or returns `nil` when the strict grammar does not
    /// cover the input; `nil` means "not handled here", never "invalid".
    static func parse(_ data: Data) -> HostJSON? {
        guard !data.isEmpty else { return nil }
        var parser = HostJSONParser(bytes: [UInt8](data))
        return try? parser.parseDocument()
    }

    private init(bytes: [UInt8]) { self.bytes = bytes }

    /// One value surrounded only by JSON whitespace; trailing bytes of any other kind reject the document.
    private mutating func parseDocument() throws -> HostJSON {
        let value = try parseValue()
        skipWhitespace()
        guard index == bytes.count else { throw Rejected() }
        return value
    }

    /// Skips the four whitespace code points RFC 8259 allows; every other byte is structural or rejected.
    private mutating func skipWhitespace() {
        while index < bytes.count {
            switch bytes[index] {
            case 0x20, 0x09, 0x0A, 0x0D: index += 1
            default: return
            }
        }
    }

    /// Dispatches on the first significant byte; an unexpected byte (including a trailing comma's `]`/`}`) rejects.
    private mutating func parseValue() throws -> HostJSON {
        skipWhitespace()
        guard index < bytes.count else { throw Rejected() }
        switch bytes[index] {
        case 0x22: return .string(try parseString())
        case 0x7B: return try parseObject()
        case 0x5B: return try parseArray()
        case 0x74: try expectLiteral(Self.trueLiteral); return .bool(true)
        case 0x66: try expectLiteral(Self.falseLiteral); return .bool(false)
        case 0x6E: try expectLiteral(Self.nullLiteral); return .null
        case 0x2D, 0x30...0x39: return .number(try parseNumber())
        default: throw Rejected()
        }
    }

    private static let trueLiteral: [UInt8] = Array("true".utf8)
    private static let falseLiteral: [UInt8] = Array("false".utf8)
    private static let nullLiteral: [UInt8] = Array("null".utf8)

    /// Consumes an exact lowercase literal; JSON has no case-insensitive or abbreviated forms.
    private mutating func expectLiteral(_ literal: [UInt8]) throws {
        guard index + literal.count <= bytes.count else { throw Rejected() }
        for (offset, expected) in literal.enumerated() where bytes[index + offset] != expected { throw Rejected() }
        index += literal.count
    }

    /// Scans the JSON number grammar, then converts with the standard library's correctly rounded `Double`
    /// parser — the same rounding Codable applies. Infinite results and nonzero literals that round to zero
    /// are not decided here: Codable rejects them, so they reject here and fall back.
    private mutating func parseNumber() throws -> Double {
        let start = index
        var nonZeroMantissa = false
        if bytes[index] == 0x2D { index += 1 }
        guard index < bytes.count else { throw Rejected() }
        if bytes[index] == 0x30 {
            index += 1
        } else if Self.isDigit(bytes[index]) {
            nonZeroMantissa = true
            index += 1
            while index < bytes.count, Self.isDigit(bytes[index]) { index += 1 }
        } else {
            throw Rejected()
        }
        if index < bytes.count, bytes[index] == 0x2E {
            index += 1
            guard index < bytes.count, Self.isDigit(bytes[index]) else { throw Rejected() }
            while index < bytes.count, Self.isDigit(bytes[index]) {
                if bytes[index] != 0x30 { nonZeroMantissa = true }
                index += 1
            }
        }
        if index < bytes.count, bytes[index] == 0x65 || bytes[index] == 0x45 {
            index += 1
            if index < bytes.count, bytes[index] == 0x2B || bytes[index] == 0x2D { index += 1 }
            guard index < bytes.count, Self.isDigit(bytes[index]) else { throw Rejected() }
            while index < bytes.count, Self.isDigit(bytes[index]) { index += 1 }
        }
        guard let value = Double(String(decoding: bytes[start..<index], as: UTF8.self)), value.isFinite else { throw Rejected() }
        if value == 0, nonZeroMantissa { throw Rejected() }
        return value
    }

    /// ASCII decimal digit test shared by the number scanner.
    private static func isDigit(_ byte: UInt8) -> Bool { (0x30...0x39).contains(byte) }

    /// Decodes a string whose opening quote is at `index`. The escape-free prefix is validated as UTF-8 in
    /// place; the first backslash switches to an accumulating buffer. Raw control characters (< 0x20) and
    /// invalid UTF-8 reject, exactly as Codable does.
    private mutating func parseString() throws -> String {
        index += 1
        let start = index
        while index < bytes.count {
            let byte = bytes[index]
            if byte == 0x22 {
                guard let text = String(validating: bytes[start..<index], as: UTF8.self) else { throw Rejected() }
                index += 1
                return text
            }
            if byte == 0x5C { break }
            if byte < 0x20 { throw Rejected() }
            index += 1
        }
        var buffer = [UInt8](bytes[start..<index])
        while index < bytes.count {
            let byte = bytes[index]
            if byte == 0x22 {
                index += 1
                guard let text = String(validating: buffer, as: UTF8.self) else { throw Rejected() }
                return text
            }
            if byte == 0x5C {
                index += 1
                try appendEscape(into: &buffer)
                continue
            }
            if byte < 0x20 { throw Rejected() }
            buffer.append(byte)
            index += 1
        }
        throw Rejected()
    }

    /// Appends the code units of the escape whose introducing backslash was just consumed; JSON defines
    /// exactly these nine escapes, so anything else rejects.
    private mutating func appendEscape(into buffer: inout [UInt8]) throws {
        guard index < bytes.count else { throw Rejected() }
        let escape = bytes[index]
        index += 1
        switch escape {
        case 0x22: buffer.append(0x22)
        case 0x5C: buffer.append(0x5C)
        case 0x2F: buffer.append(0x2F)
        case 0x62: buffer.append(0x08)
        case 0x66: buffer.append(0x0C)
        case 0x6E: buffer.append(0x0A)
        case 0x72: buffer.append(0x0D)
        case 0x74: buffer.append(0x09)
        case 0x75: UTF8.encode(try parseUnicodeEscape()) { buffer.append($0) }
        default: throw Rejected()
        }
    }

    /// Reads the four hex digits after `\u`, pairing a high surrogate with the mandatory following `\u` low
    /// surrogate; a lone or mismatched surrogate is not a scalar and rejects.
    private mutating func parseUnicodeEscape() throws -> Unicode.Scalar {
        let first = try parseHex4()
        if (0xD800...0xDBFF).contains(first) {
            guard index + 1 < bytes.count, bytes[index] == 0x5C, bytes[index + 1] == 0x75 else { throw Rejected() }
            index += 2
            let second = try parseHex4()
            guard (0xDC00...0xDFFF).contains(second) else { throw Rejected() }
            let combined = 0x10000 + ((UInt32(first) - 0xD800) << 10) + (UInt32(second) - 0xDC00)
            guard let scalar = Unicode.Scalar(combined) else { throw Rejected() }
            return scalar
        }
        guard let scalar = Unicode.Scalar(UInt32(first)) else { throw Rejected() }
        return scalar
    }

    /// Four hexadecimal digits (either case) as a UTF-16 code unit.
    private mutating func parseHex4() throws -> UInt16 {
        guard index + 4 <= bytes.count else { throw Rejected() }
        var value: UInt16 = 0
        for _ in 0..<4 {
            let digit: UInt16
            switch bytes[index] {
            case 0x30...0x39: digit = UInt16(bytes[index] - 0x30)
            case 0x41...0x46: digit = UInt16(bytes[index] - 0x41 + 10)
            case 0x61...0x66: digit = UInt16(bytes[index] - 0x61 + 10)
            default: throw Rejected()
            }
            value = value << 4 | digit
            index += 1
        }
        return value
    }

    /// Array whose `[` is at `index`; elements are comma-separated with no trailing comma.
    private mutating func parseArray() throws -> HostJSON {
        index += 1
        depth += 1
        guard depth <= Self.maxDepth else { throw Rejected() }
        defer { depth -= 1 }
        var elements: [HostJSON] = []
        skipWhitespace()
        if index < bytes.count, bytes[index] == 0x5D {
            index += 1
            return .array(elements)
        }
        while true {
            elements.append(try parseValue())
            skipWhitespace()
            guard index < bytes.count else { throw Rejected() }
            switch bytes[index] {
            case 0x2C: index += 1
            case 0x5D: index += 1; return .array(elements)
            default: throw Rejected()
            }
        }
    }

    /// Object whose `{` is at `index`; keys are strings, members are comma-separated with no trailing comma,
    /// and a repeated key rejects so Codable's duplicate-key policy — whatever Foundation implements — applies.
    private mutating func parseObject() throws -> HostJSON {
        index += 1
        depth += 1
        guard depth <= Self.maxDepth else { throw Rejected() }
        defer { depth -= 1 }
        var members: [String: HostJSON] = [:]
        skipWhitespace()
        if index < bytes.count, bytes[index] == 0x7D {
            index += 1
            return .object(members)
        }
        while true {
            skipWhitespace()
            guard index < bytes.count, bytes[index] == 0x22 else { throw Rejected() }
            let key = try parseString()
            skipWhitespace()
            guard index < bytes.count, bytes[index] == 0x3A else { throw Rejected() }
            index += 1
            let value = try parseValue()
            guard members.updateValue(value, forKey: key) == nil else { throw Rejected() }
            skipWhitespace()
            guard index < bytes.count else { throw Rejected() }
            switch bytes[index] {
            case 0x2C: index += 1
            case 0x7D: index += 1; return .object(members)
            default: throw Rejected()
            }
        }
    }
}
