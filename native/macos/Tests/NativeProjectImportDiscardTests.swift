import Foundation
import Testing
@testable import PlotWeaveNative

/// Real temporary-directory evidence distinguishes project quarantine from a mocked cleanup call (issue #864).
struct NativeProjectImportDiscardTests {
    /// Unbound copies leave the active directory, keep exact media bytes and persist a readable receipt.
    @Test func rejectedImportIsQuarantinedWithReceipt() async throws {
        let fixture = try await Fixture()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let asset = try await fixture.copy()
        let assetId = try #require(asset["id"]?.string)
        let original = fixture.root.appendingPathComponent("projects/\(fixture.id)/\(try #require(asset["relPath"]?.string))")
        try await fixture.store.discardImport(id: fixture.id, assetId: assetId)
        #expect(!FileManager.default.fileExists(atPath: original.path))
        let trash = original.deletingLastPathComponent().appendingPathComponent(".trash")
        let slots = try FileManager.default.contentsOfDirectory(at: trash, includingPropertiesForKeys: nil)
        let slot = try #require(slots.first)
        #expect(slots.count == 1)
        #expect(try Data(contentsOf: slot.appendingPathComponent("media")) == fixture.bytes)
        let record = try JSONDecoder().decode(NativeProjectImportReceipt.Record.self, from: Data(contentsOf: slot.appendingPathComponent("receipt.json")))
        #expect(record.assetId == assetId)
        await #expect(throws: HostFailure.self) { try await fixture.store.openMedia(id: fixture.id, assetId: assetId) }
    }

    /// Once accepted by a save, even a later undo save cannot grant discard authority over redo media.
    @Test func acceptedImportCannotBeDiscardedAfterUndoSave() async throws {
        let fixture = try await Fixture()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let asset = try await fixture.copy()
        let assetId = try #require(asset["id"]?.string)
        var doc = try #require(try await fixture.store.loadProject(id: fixture.id).object)
        doc["assets"] = .object(["byId": .object([assetId: asset])])
        _ = try await fixture.store.invoke(command: "save_project", args: ["id": .string(fixture.id), "doc": .object(doc)])
        doc["assets"] = .object(["byId": .object([:])])
        _ = try await fixture.store.invoke(command: "save_project", args: ["id": .string(fixture.id), "doc": .object(doc)])
        await #expect(throws: HostFailure.self) { try await fixture.store.discardImport(id: fixture.id, assetId: assetId) }
        let path = fixture.root.appendingPathComponent("projects/\(fixture.id)/\(try #require(asset["relPath"]?.string))")
        #expect(try Data(contentsOf: path) == fixture.bytes)
    }

    /// Replacement identities are evidence to preserve, never authority to remove someone else's bytes.
    @Test func replacementIsNotQuarantined() async throws {
        let fixture = try await Fixture()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let asset = try await fixture.copy()
        let path = fixture.root.appendingPathComponent("projects/\(fixture.id)/\(try #require(asset["relPath"]?.string))")
        try FileManager.default.removeItem(at: path)
        try Data("replacement".utf8).write(to: path)
        await #expect(throws: HostFailure.self) {
            try await fixture.store.discardImport(id: fixture.id, assetId: try #require(asset["id"]?.string))
        }
        #expect(try Data(contentsOf: path) == Data("replacement".utf8))
    }

    /// Each fixture owns a fresh real project and library-style copy without touching developer data.
    private struct Fixture {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-import-discard-" + UUID().uuidString)
        let store: NativeProjectStore
        let id: String
        let bytes = Data([1, 2, 3])
        init() async throws {
            store = NativeProjectStore(root: root)
            let created = try await store.invoke(command: "create_project", args: ["name": .string("discard")])
            id = try #require(created["id"]?.string)
        }
        func copy() async throws -> HostJSON {
            try await store.importMedia(id: id, bytes: bytes, mime: "image/png", source: "upload", extension: "png", discardable: true)
        }
    }
}
