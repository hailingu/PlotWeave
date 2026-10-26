import Darwin
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

    /// A synchronous receipt-open failure must roll back the newly committed copy before returning (#890).
    @Test(arguments: [EMFILE, EIO])
    func receiptFailureRollsBackCommittedMedia(reason: Int32) async throws {
        let fixture = try await Fixture()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        await #expect(throws: HostFailure.self) {
            try await fixture.store.importMedia(id: fixture.id, bytes: fixture.bytes, mime: "image/png", source: "upload", extension: "png", discardable: true, prepareReceipt: { _, _, _ in
                errno = reason
                throw NativeDirectory.ioError("injected receipt open")
            })
        }
        let assets = fixture.root.appendingPathComponent("projects/\(fixture.id)/assets")
        #expect(try FileManager.default.contentsOfDirectory(atPath: assets.path).isEmpty)
        #expect(await fixture.store.pendingMedia[fixture.id]?.isEmpty != false)
        #expect(await fixture.store.importReceipts[fixture.id]?.isEmpty != false)
    }

    /// Undo before a first acceptance save keeps redo bytes across save/exit; no restart receipt is invented (#886).
    @Test func undoSaveExitRetainsDocumentedMediaBoundary() async throws {
        let fixture = try await Fixture()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let asset = try await fixture.copy()
        let assetId = try #require(asset["id"]?.string)
        let doc = try await fixture.store.loadProject(id: fixture.id)
        _ = try await fixture.store.invoke(command: "save_project", args: ["id": .string(fixture.id), "doc": doc])
        #expect(try await fixture.store.validateAsset(id: fixture.id, asset: asset) == asset)
        await fixture.store.close()
        let reopened = NativeProjectStore(root: fixture.root)
        let loaded = try await reopened.loadProject(id: fixture.id)
        #expect(loaded["assets"]?["byId"]?.object == [:])
        let path = fixture.root.appendingPathComponent("projects/\(fixture.id)/\(try #require(asset["relPath"]?.string))")
        #expect(try Data(contentsOf: path) == fixture.bytes)
        await #expect(throws: HostFailure.self) { try await reopened.discardImport(id: fixture.id, assetId: assetId) }
        await reopened.close()
    }

    /// Persistent cleanup refusal is explicit and does not publish a phantom pending asset (#890).
    @Test func failedRollbackReportsRetainedCopy() async throws {
        let fixture = try await Fixture()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let assets = fixture.root.appendingPathComponent("projects/\(fixture.id)/assets")
        defer { chmod(assets.path, mode_t(S_IRWXU)) }
        do {
            _ = try await fixture.store.importMedia(id: fixture.id, bytes: fixture.bytes, mime: "image/png", source: "upload", extension: "png", discardable: true, prepareReceipt: { directory, _, _ in
                #expect(fchmod(directory.descriptor, mode_t(S_IRUSR | S_IXUSR)) == 0)
                throw HostFailure(code: "PW_STORAGE_ERROR", message: "fixture receipt failure")
            })
            Issue.record("Import unexpectedly succeeded after receipt failure")
        } catch let failure as HostFailure {
            #expect(failure.code == "PW_IMPORT_ROLLBACK_FAILED")
            #expect(failure.message.contains("fixture receipt failure"))
        }
        #expect(try FileManager.default.contentsOfDirectory(atPath: assets.path).count == 1)
        #expect(await fixture.store.pendingMedia[fixture.id]?.isEmpty != false)
        #expect(await fixture.store.importReceipts[fixture.id]?.isEmpty != false)
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
