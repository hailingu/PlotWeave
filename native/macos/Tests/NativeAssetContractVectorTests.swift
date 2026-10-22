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
