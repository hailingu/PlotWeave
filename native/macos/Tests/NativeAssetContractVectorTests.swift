import Foundation
import Testing
@testable import PlotWeaveNative

/// Issues #649/#650: both hosts evaluate one versioned wire-data corpus independently.
struct NativeAssetContractVectorTests {
    /// Canonical path and MIME verdicts are contracts rather than duplicated implementation assertions.
    @Test func sharedAssetContractVectors() throws {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("crates/plotweave-core/testdata/asset-contract.json")
        let vectors = try JSONDecoder().decode(HostJSON.self, from: Data(contentsOf: file))
        #expect(vectors["version"] == .number(1))
        let paths = try #require(vectors["relPaths"]?.arrayValue)
        let mimes = try #require(vectors["mimes"]?.arrayValue)
        #expect(!paths.isEmpty && !mimes.isEmpty)
        for row in paths {
            let path = try #require(row["input"]?.string)
            #expect(HostJSON.bool(NativeAssetContract.lexicalRelPath(path)) == row["lexical"], "\(row["id"] ?? .null)")
            #expect(HostJSON.bool(NativeAssetContract.activeRelPath(path)) == row["active"], "\(row["id"] ?? .null)")
        }
        for row in mimes {
            let mime = try #require(row["input"]?.string)
            #expect(HostJSON.bool(NativeAssetContract.mime(mime)) == row["accepted"], "\(row["id"] ?? .null)")
        }
    }

    /// Issue #824: timestamp accept/reject verdicts and normalized outputs are contract vectors that the
    /// cached-tooling rewrite (strict fast path plus shared legacy formatters) must reproduce byte-for-byte.
    @Test func timestampNormalizationVectors() throws {
        let accepted: [(String, String)] = [
            ("2026-10-04T00:00:00.000Z", "2026-10-04T00:00:00.000Z"),
            ("2026-10-04T00:00:00Z", "2026-10-04T00:00:00.000Z"),
            ("2026-10-04T00:00:00.5Z", "2026-10-04T00:00:00.500Z"),
            ("2026-10-04T00:00:00.12Z", "2026-10-04T00:00:00.120Z"),
            ("2026-10-04T00:00:00.123456Z", "2026-10-04T00:00:00.123Z"),
            ("2026-10-04T08:00:00.000+08:00", "2026-10-04T00:00:00.000Z"),
            ("2026-10-04T00:00:00-05:30", "2026-10-04T05:30:00.000Z"),
            ("1969-12-31T23:59:59.999Z", "1969-12-31T23:59:59.999Z"),
            ("2024-02-29T12:00:00.000Z", "2024-02-29T12:00:00.000Z"),
            ("2026-10-04T00:00:00+00:00", "2026-10-04T00:00:00.000Z"),
            ("2026-10-04T24:00:00.000Z", "2026-10-05T00:00:00.000Z"),
            ("2023-02-29T00:00:00.000Z", "2023-03-01T00:00:00.000Z")
        ]
        for (input, expected) in accepted {
            #expect(NativeAssetContract.normalizedTimestamp(input) == expected, "normalize \(input)")
            if input == expected { #expect(NativeAssetContract.canonicalUTC(input)) }
        }
        let rejected = ["2026-13-01T00:00:00.000Z", "2026-00-04T00:00:00.000Z", "2026-10-00T00:00:00.000Z",
                        "2026-10-04T00:60:00.000Z", "2026-10-04T00:00:60.000Z", "2026-10-04T00:00:00",
                        "2026-10-04 00:00:00.000Z", "2026-10-04t00:00:00.000Z", "not-a-date", ""]
        for input in rejected {
            #expect(NativeAssetContract.normalizedTimestamp(input) == nil, "reject \(input)")
            #expect(!NativeAssetContract.canonicalUTC(input), "not canonical \(input)")
        }
    }

    /// Issue #824: envelope parsing accepts the same timestamp forms and resolves the same millisecond
    /// instants as the library normalization contract.
    @Test func envelopeParseTimeVectors() throws {
        let accepted: [(String, Double)] = [
            ("2026-10-04T00:00:00.000Z", 1_791_072_000.0),
            ("2026-10-04T00:00:00Z", 1_791_072_000.0),
            ("2026-10-04T00:00:00.5Z", 1_791_072_000.5),
            ("2026-10-04T08:00:00+08:00", 1_791_072_000.0),
            ("1969-12-31T23:00:00.000Z", -3_600.0)
        ]
        for (input, expected) in accepted {
            let parsed = try #require(NativeProjectEnvelope.parseTime(input), "parse \(input)")
            #expect(parsed.timeIntervalSince1970 == expected, "\(input) instant")
        }
        let rejected = ["", "not-a-date", "2026-10-04T00:00:00", "2026-10-04t00:00:00.000Z", "2026-10-04"]
        for input in rejected {
            #expect(NativeProjectEnvelope.parseTime(input) == nil, "reject \(input)")
        }
    }

    /// Real host I/O reports reserved entries, refuses an unrepaired save and preserves all quarantine bytes.
    @Test func quarantineAssetReferencesRecoverWithoutTouchingBytes() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-active-contract-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = NativeProjectStore(root: root)
        let created = try await store.invoke(command: "create_project", args: ["name": .string("contract")])
        let id = try #require(created["id"]?.string)
        let record = root.appendingPathComponent("projects/\(id).json")
        var doc = try #require(try await store.invoke(command: "load_project", args: ["id": .string(id)]).object)
        let assets = root.appendingPathComponent("projects/\(id)/assets")
        try FileManager.default.createDirectory(at: assets.appendingPathComponent(".trash"), withIntermediateDirectories: true)
        try Data("quarantined".utf8).write(to: assets.appendingPathComponent(".trash/held.png"))
        try Data("active".utf8).write(to: assets.appendingPathComponent("ok.png"))
        doc["assets"] = .object(["byId": .object([
            "held": Self.asset("held", path: "assets/.trash/held.png"),
            "missing": Self.asset("missing", path: "assets/.trash/missing.png"),
            "ok": Self.asset("ok", path: "assets/ok.png")
        ])])
        let original = try JSONEncoder().encode(HostJSON.object(doc))
        try original.write(to: record)
        let loaded = try await store.invoke(command: "load_project", args: ["id": .string(id)])
        let invalid = try await store.invoke(command: "verify_project_assets", args: ["id": .string(id), "assets": try #require(loaded["assets"])])
        #expect(invalid == .array([.string("held"), .string("missing")]))
        await #expect(throws: HostFailure.self) {
            try await store.invoke(command: "save_project", args: ["id": .string(id), "doc": loaded, "expectExisting": .bool(true)])
        }
        #expect(try Data(contentsOf: record) == original)
        doc["assets"] = .object(["byId": .object(["ok": Self.asset("ok", path: "assets/ok.png")])])
        _ = try await store.invoke(command: "save_project", args: ["id": .string(id), "doc": .object(doc), "expectExisting": .bool(true)])
        let reopened = try await NativeProjectStore(root: root).invoke(command: "load_project", args: ["id": .string(id)])
        #expect(reopened["assets"] == doc["assets"])
        #expect(reopened["graph"] == doc["graph"])
        #expect(try Data(contentsOf: assets.appendingPathComponent(".trash/held.png")) == Data("quarantined".utf8))
        #expect(try Data(contentsOf: assets.appendingPathComponent("ok.png")) == Data("active".utf8))
    }

    /// Canonical metadata keeps the regression focused on the reserved namespace.
    private static func asset(_ id: String, path: String) -> HostJSON {
        .object(["id": .string(id), "relPath": .string(path), "mime": .string("image/png"),
                 "source": .string("upload"), "createdAt": .string("2026-08-01T00:00:00.000Z")])
    }
}
