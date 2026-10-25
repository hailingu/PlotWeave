import Foundation
import Testing
@testable import PlotWeaveNative

/// Issue #825: `HostJSON.decode` is a drop-in for `JSONDecoder().decode(HostJSON.self, from:)` on the storage
/// and WebKit hot paths. Its contract is equivalence — the same value for every document Codable accepts and
/// rejection for every document Codable rejects — with `HostJSONParser` carrying canonical input and everything
/// else falling back to Codable. Vectors run through both entries and compare bit-for-bit, so no assertion
/// depends on Foundation's error prose.
struct HostJSONDecodeTests {
    /// Encoder output — what the store, the Web session and the fixtures write — takes the strict path and
    /// reproduces the original tree exactly under compact, pretty-printed and key-sorted formatting alike.
    @Test func canonicalDocumentsTakeTheStrictPathAndMatchCodable() throws {
        let document = Self.envelopeDocument()
        for formatting in [JSONEncoder.OutputFormatting(), [.prettyPrinted], [.sortedKeys, .prettyPrinted]] {
            let encoder = JSONEncoder()
            encoder.outputFormatting = formatting
            let data = try encoder.encode(document)
            let decoded = try #require(expectEquivalent(data, strict: true))
            #expect(bitwiseEqual(decoded, document))
        }
    }

    /// Every scalar kind is accepted at the top level too: the WebKit bridge serializes fragments.
    @Test(arguments: [
        "true", "false", "null", "0", "-0", "1", "-1", "1.5", "0.1", "1e2", "1E-2", "1e+2", "123e-2",
        "\"\"", "\"str\"", "[]", "{}", " 1 ", "\n\"x\"\n", "\t[\r\n]\t", "{\"a\":[{}],\"b\":[[]]}",
    ])
    func scalarsAndFragmentsTakeTheStrictPath(text: String) {
        expectEquivalent(Data(text.utf8), strict: true)
    }

    /// Numbers always become `Double`: integers beyond 2^53 round like Codable does, `-0` keeps its sign,
    /// and `0`/`1` never collapse into booleans.
    @Test func numbersAlwaysBecomeDoubleWithCodableRounding() throws {
        let mixed = try HostJSON.decode(Data("[1,0,true,false,-0,9007199254740993]".utf8))
        #expect(mixed == .array([.number(1), .number(0), .bool(true), .bool(false), .number(0), .number(Double(9_007_199_254_740_992))]))
        let negativeZero = try #require(mixed.arrayValue?[4])
        guard case .number(let value) = negativeZero else {
            Issue.record("-0 必须解码为数值")
            return
        }
        #expect(value.sign == .minus)
        #expect(try HostJSON.decode(Data("18446744073709551616".utf8)) == .number(18_446_744_073_709_551_616))
        #expect(try HostJSON.decode(Data("1.7976931348623157e308".utf8)) == .number(.greatestFiniteMagnitude))
        #expect(try HostJSON.decode(Data("5e-324".utf8)) == .number(.leastNonzeroMagnitude))
        #expect(try HostJSON.decode(Data("2.5e-324".utf8)) == .number(.leastNonzeroMagnitude))
        for text in ["1e309", "-1e309", "1e-400", "1e-324", "1.7976931348623159e308", "0e99999999999", "1e99999999999999999999"] {
            expectEquivalent(Data("[\(text)]".utf8))
        }
    }

    /// Escapes, surrogate pairs, raw UTF-8 and NUL survive on the strict path.
    @Test(arguments: [
        ("\"\\u00e9\\ud83d\\ude00\"", "é😀"), ("\"\\n\\t\\\"\\\\\\/\\b\\f\\r\"", "\n\t\"\\/\u{08}\u{0C}\r"),
        ("\"\\u0000\"", "\u{0}"), ("\"plain 中文 😀\"", "plain 中文 😀"), ("\"\\uDBFF\\uDFFF\"", "\u{10FFFF}"),
        ("\"a\u{7f}b\"", "a\u{7f}b"), ("\"\\u2028\\u2029\"", "\u{2028}\u{2029}"), ("\"\\uFFFD\\uFFFE\"", "\u{FFFD}\u{FFFE}"),
    ])
    func stringsDecodeEscapesOnTheStrictPath(text: String, expected: String) {
        #expect(expectEquivalent(Data(text.utf8), strict: true) == .string(expected))
    }

    /// Lone surrogates, unknown escapes, raw control characters and invalid UTF-8 are rejected by both entries.
    @Test(arguments: HostJSONDecodeTests.malformedStrings)
    func malformedStringsRejectThroughBothEntries(data: Data) {
        expectEquivalent(data)
        #expect((try? HostJSON.decode(data)) == nil)
    }

    /// Malformed string vectors as bytes: escaped text plus raw invalid UTF-8 sequences.
    private static let malformedStrings: [Data] = [
        "\"\\ud800\"", "\"\\udc00\"", "\"\\ud800x\"", "\"\\ud800\\u0041\"", "\"\\x41\"", "\"\\'\"", "\"\\u12\"", "\"\\u12g4\"",
        "\"a\u{1}b\"", "\"a\tb\"", "\"unterminated", "\"trailing\\",
    ].map { Data($0.utf8) } + [
        Data([0xFF]), Data([0x5B, 0x22, 0xFF, 0x22, 0x5D]), Data([0x5B, 0x22, 0xC0, 0x80, 0x22, 0x5D]),
        Data([0x5B, 0x22, 0xED, 0xA0, 0x80, 0x22, 0x5D]), Data([0x7B, 0x7D, 0x00]),
    ]

    /// Structural garbage is rejected by both entries; the acceptance set is Codable's, not the parser's.
    @Test(arguments: [
        "", " ", "{", "[", "]", "{\"a\":1}x", "NaN", "Infinity", "-Infinity", "-", "1.", ".5", "01", "-01", "+1",
        "1e", "1.e5", "1e5.5", "00", "0x10", "tru", "nul", "True", "'a'", "{a:1}", "[1 2]", "{\"a\" 1}", "{\"a\":}",
        "{}}", "[]]", "1 2", "// c\n1", "/* c */1", "{\"a\":1,,}", "[,1]", "{,}", "{\"a\":1 \"b\":2}", "[1}", "{\"a\":1]",
    ])
    func malformedDocumentsRejectThroughBothEntries(text: String) {
        let data = Data(text.utf8)
        expectEquivalent(data)
        #expect((try? HostJSON.decode(data)) == nil)
    }

    /// Inputs the strict parser refuses — Codable's leniencies and non-UTF-8 encodings — still produce
    /// whatever Codable produces, so adopting `decode` changes no outcome; `strict: false` pins the boundary.
    @Test(arguments: HostJSONDecodeTests.lenientInputs)
    func codableLeniencesStayAvailableThroughFallback(data: Data) {
        expectEquivalent(data, strict: false)
    }

    /// Trailing commas, duplicate keys, non-JSON whitespace, a UTF-8 BOM, and UTF-16 with and without a BOM.
    private static let lenientInputs: [Data] = [
        "[1,]", "{\"a\":1,}", "{\"a\":1,\"a\":2}", "{\"a\":{\"x\":1},\"a\":{\"y\":2}}", "[1\u{0C}]", "[1\u{A0}]",
    ].map { Data($0.utf8) } + [
        Data([0xEF, 0xBB, 0xBF, 0x7B, 0x7D]), Data([0xFF, 0xFE, 0x7B, 0x00, 0x7D, 0x00]), Data([0x7B, 0x00, 0x7D, 0x00]),
    ]

    /// Nesting: documents up to `HostJSONParser.maxDepth` are decoded on the strict path, deeper ones are handed
    /// to Codable, and both entries agree at every depth. Depths stay below Foundation's own recursion limit on
    /// a 512 KiB test thread so the comparison exercises values, not stack exhaustion.
    @Test(arguments: [1, 16, 64, 127, 128, 129, 160])
    func nestingDepthMatchesCodable(depth: Int) throws {
        let arrays = Data((String(repeating: "[", count: depth) + String(repeating: "]", count: depth)).utf8)
        let objects = Data((String(repeating: "{\"a\":", count: depth) + "1" + String(repeating: "}", count: depth)).utf8)
        let strictHandles = depth <= HostJSONParser.maxDepth
        try #require(expectEquivalent(arrays, strict: strictHandles) != nil)
        try #require(expectEquivalent(objects, strict: strictHandles) != nil)
    }

    /// Seeded random trees — every value kind, awkward keys, empty containers — round-trip through
    /// `JSONEncoder` on the strict path and match Codable bit-for-bit.
    @Test func seededRandomDocumentsDecodeIdentically() throws {
        var generator = SeededGenerator(seed: 0x825)
        let encoder = JSONEncoder()
        var checked = 0
        for _ in 0..<1_200 {
            let document = Self.randomValue(depth: 0, using: &generator)
            let data = try encoder.encode(document)
            let decoded = try #require(expectEquivalent(data, strict: true))
            #expect(bitwiseEqual(decoded, document))
            checked += 1
        }
        #expect(checked == 1_200)
    }

    /// Seeded random numbers in every textual form an encoder or a hand edit can produce decode to the same
    /// bits through both entries; overflow and underflow forms simply agree on rejection.
    @Test func seededRandomNumbersDecodeBitIdentically() {
        var generator = SeededGenerator(seed: 0x825_0001)
        var strictHandled = 0
        for ordinal in 0..<3_000 {
            let text = Self.randomNumberText(ordinal: ordinal, using: &generator)
            let data = Data("[\(text)]".utf8)
            expectEquivalent(data)
            if HostJSONParser.parse(data) != nil { strictHandled += 1 }
        }
        #expect(strictHandled > 2_900)
    }

    /// `init(webValue:)` keeps its contract for the Foundation trees WebKit delivers: NSNumber booleans stay
    /// distinct from 0/1, fragments are accepted, and a document survives the round trip through `webValue`.
    @Test func webValueBridgeKeepsItsContract() throws {
        let nested: [String: Any] = [
            "a": true, "b": 1, "c": 0, "d": NSNull(), "e": "s", "f": [1.5, false, "x"] as [Any],
            "g": NSNumber(value: true), "h": NSNumber(value: 1), "i": ["k": [String: Any]()] as [String: Any],
        ]
        #expect(try HostJSON(webValue: nested) == .object([
            "a": .bool(true), "b": .number(1), "c": .number(0), "d": .null, "e": .string("s"),
            "f": .array([.number(1.5), .bool(false), .string("x")]), "g": .bool(true), "h": .number(1), "i": .object(["k": .object([:])]),
        ]))
        #expect(try HostJSON(webValue: true) == .bool(true))
        #expect(try HostJSON(webValue: 42) == .number(42))
        #expect(try HostJSON(webValue: "x") == .string("x"))
        #expect(try HostJSON(webValue: NSNull()) == .null)
        #expect(try HostJSON(webValue: [Any]()) == .array([]))
        let document = Self.envelopeDocument()
        #expect(bitwiseEqual(try HostJSON(webValue: document.webValue), document))
    }

    /// Representative v1 envelope with every value kind the Web session writes.
    private static func envelopeDocument() -> HostJSON {
        let script = String(repeating: "她推开门，雨声灌进来，屋里没有人回答。", count: 20)
        var scenes: [HostJSON] = []
        var edges: [HostJSON] = []
        for index in 0..<12 {
            scenes.append(.object([
                "id": .string("scene-\(index)"), "type": .string("scene"),
                "position": .object(["x": .number(Double(index % 8) * 320.5), "y": .number(-Double(index / 8) * 200)]),
                "data": .object([
                    "title": .string("第 \(index + 1) 场 \"引号\"\\反斜杠\n换行\t制表 😀"), "script": .string(script),
                    "episode": .number(Double(index / 10 + 1)), "draft": .bool(index % 2 == 0), "note": .null, "tags": .array([]),
                ]),
            ]))
            if index > 0 {
                edges.append(.object(["id": .string("e-\(index)"), "source": .string("scene-\(index - 1)"), "target": .string("scene-\(index)")]))
            }
        }
        return .object([
            "schemaVersion": .number(1),
            "project": .object([
                "id": .string("p-825"), "name": .string(""), "createdAt": .string("2026-10-04T00:00:00.000Z"), "updatedAt": .string("2026-10-25T12:34:56.789Z"),
            ]),
            "graph": .object(["nodes": .array(scenes), "edges": .array(edges), "viewport": .object(["x": .number(0), "y": .number(-0.0), "zoom": .number(0.1)])]),
            "settings": .object(["characters": .object([:]), "locations": .object([:]), "props": .object([:]), "documents": .object([:])]),
            "episodeTitles": .object(["1": .string("第一集")]), "assets": .object(["byId": .object([:])]),
        ])
    }

    /// Random JSON tree bounded in depth and width; numbers cover integers, decimals and raw bit patterns.
    private static func randomValue(depth: Int, using generator: inout SeededGenerator) -> HostJSON {
        let kinds = depth > 3 ? 4 : 6
        switch Int.random(in: 0..<kinds, using: &generator) {
        case 0: return .null
        case 1: return .bool(Bool.random(using: &generator))
        case 2: return .number(randomDouble(using: &generator))
        case 3: return .string(Self.stringPool[Int.random(in: 0..<Self.stringPool.count, using: &generator)])
        case 4: return .array((0..<Int.random(in: 0...5, using: &generator)).map { _ in randomValue(depth: depth + 1, using: &generator) })
        default:
            var object: [String: HostJSON] = [:]
            for _ in 0..<Int.random(in: 0...5, using: &generator) {
                let key = Self.keyPool[Int.random(in: 0..<Self.keyPool.count, using: &generator)] + "\(Int.random(in: 0...9, using: &generator))"
                object[key] = randomValue(depth: depth + 1, using: &generator)
            }
            return .object(object)
        }
    }

    /// Finite doubles only: `JSONEncoder` refuses NaN and infinity, which the Web can never persist either.
    private static func randomDouble(using generator: inout SeededGenerator) -> Double {
        switch Int.random(in: 0..<4, using: &generator) {
        case 0: return Double(Int.random(in: -1000...1000, using: &generator))
        case 1: return Double.random(in: -1e6...1e6, using: &generator)
        case 2: return Double(Int64.random(in: Int64.min...Int64.max, using: &generator))
        default:
            let value = Double(bitPattern: UInt64.random(in: 0...UInt64.max, using: &generator))
            return value.isFinite ? value : 1
        }
    }

    /// Number spellings: shortest round-trip, 17 and 25 significant digits, signed and unsigned 64-bit, long integers.
    private static func randomNumberText(ordinal: Int, using generator: inout SeededGenerator) -> String {
        switch ordinal % 6 {
        case 0: return "\(randomDouble(using: &generator))"
        case 1: return String(format: "%.17g", Double.random(in: -1e6...1e6, using: &generator))
        case 2: return "\(Int64.random(in: Int64.min...Int64.max, using: &generator))"
        case 3: return "\(UInt64.random(in: 0...UInt64.max, using: &generator))"
        case 4:
            let digits = (0..<Int.random(in: 20...40, using: &generator)).map { _ in String(Int.random(in: 0...9, using: &generator)) }.joined()
            return (Bool.random(using: &generator) ? "-" : "") + "1" + digits
        default: return String(format: "%.25e", randomDouble(using: &generator))
        }
    }

    private static let stringPool = [
        "", "a", "中文", "😀", "\n\t\"\\/", "\u{0}", "\u{7f}", "é", "\u{2028}", "\u{FFFD}", "\u{10FFFF}", "\u{FFFE}",
        String(repeating: "ab 字😀", count: 40), "<script>", "\u{1F}\u{1E}",
    ]
    private static let keyPool = ["id", "name", "", "中", "k", "\"q\"", "\\", " ", "😀"]
}

/// Decodes through both entries and records a single issue if they disagree on acceptance or on any bit of
/// the value. `strict` additionally pins whether `HostJSONParser` itself handled the bytes: `true` guards the
/// hot path against a silent all-fallback regression, `false` documents a leniency that stays with Codable.
@discardableResult
private func expectEquivalent(_ data: Data, strict: Bool? = nil, sourceLocation: SourceLocation = #_sourceLocation) -> HostJSON? {
    let codable = try? JSONDecoder().decode(HostJSON.self, from: data)
    let decoded = try? HostJSON.decode(data)
    switch (codable, decoded) {
    case (nil, nil): break
    case (let expected?, let actual?):
        #expect(bitwiseEqual(expected, actual), "两条解码入口的值不一致", sourceLocation: sourceLocation)
    default:
        Issue.record("两条解码入口的接受结果不一致：Codable=\(codable != nil) decode=\(decoded != nil)", sourceLocation: sourceLocation)
    }
    if let strict {
        #expect((HostJSONParser.parse(data) != nil) == strict, "严格解析器的处理边界与预期不符", sourceLocation: sourceLocation)
    }
    return decoded
}

/// Structural equality with bitwise numbers: `Double ==` would let `-0`/`0` or a one-ULP drift pass.
private func bitwiseEqual(_ lhs: HostJSON, _ rhs: HostJSON) -> Bool {
    switch (lhs, rhs) {
    case (.null, .null): return true
    case (.bool(let left), .bool(let right)): return left == right
    case (.number(let left), .number(let right)): return left.bitPattern == right.bitPattern
    case (.string(let left), .string(let right)): return left == right
    case (.array(let left), .array(let right)): return left.count == right.count && zip(left, right).allSatisfy(bitwiseEqual)
    case (.object(let left), .object(let right)):
        return left.count == right.count && left.allSatisfy { key, value in right[key].map { bitwiseEqual(value, $0) } ?? false }
    default: return false
    }
}

/// Deterministic SplitMix64 so a failing random vector reproduces from the recorded seed.
private struct SeededGenerator: RandomNumberGenerator {
    private var state: UInt64

    /// Seeds the stream; equal seeds yield equal vector sequences across runs and machines.
    init(seed: UInt64) { state = seed }

    /// Next 64 random bits (SplitMix64 output function).
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var mixed = state
        mixed = (mixed ^ (mixed >> 30)) &* 0xBF58_476D_1CE4_E5B9
        mixed = (mixed ^ (mixed >> 27)) &* 0x94D0_49BB_1331_11EB
        return mixed ^ (mixed >> 31)
    }
}
