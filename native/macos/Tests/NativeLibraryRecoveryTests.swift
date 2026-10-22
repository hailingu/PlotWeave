import CryptoKit
import Darwin
import Foundation
import Testing
@testable import PlotWeaveNative

/// Recovery fixtures use the existing journal wire contract and inspect retained bytes across actor restarts.
@MainActor
struct NativeLibraryRecoveryTests {
    /// A crash before index commit restores the exact media instead of removing the still-indexed asset.
    @Test func uncommittedDeleteRestoresMediaAndClearsJournal() async throws {
        let fixture = try await seed()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let entry = try quarantine(fixture)
        try writeJournal(fixture.root, entries: [entry])
        let library = NativeLibrary(root: fixture.root)
        let list = try await library.invoke(command: "list_library_assets", args: [:])
        #expect(list["assets"]?["byId"]?[fixture.id] != nil)
        let file = try await library.openMedia(id: fixture.id)
        #expect(try file.read(maxBytes: 20) == Data([1, 2, 3]))
        let journal = try JSONDecoder().decode(HostJSON.self, from: Data(contentsOf: fixture.root.appendingPathComponent("library/asset-delete-journal.json")))
        #expect(journal["entries"]?.array.isEmpty == true)
        #expect(list["cleanupPending"]?.array.isEmpty == true)
    }

    /// A committed deletion folds retention exactly once and stays stable after repeated reads and restart.
    @Test func committedDeleteAggregatesRetentionExactlyOnce() async throws {
        let fixture = try await seed()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let entry = try quarantine(fixture)
        let empty = HostJSON.object(["assets": .object(["byId": .object([:])]), "groups": .object(["byId": .object([:])])])
        try JSONEncoder().encode(empty).write(to: fixture.root.appendingPathComponent("library/library.json"))
        try writeJournal(fixture.root, entries: [entry])
        for _ in 0..<3 {
            let list = try await NativeLibrary(root: fixture.root).invoke(command: "list_library_assets", args: [:])
            let summary = try #require(list["cleanupPending"]?.array.first)
            #expect(summary["count"] == .number(1))
            #expect(summary["bytes"] == .number(3))
        }
        #expect(try Data(contentsOf: fixture.root.appendingPathComponent("library/assets/.trash/recovery")) == Data([1, 2, 3]))
    }

    /// Partial salvage cannot authorize a committed delete; conflicts block serving/importing that identity.
    @Test func damagedIndexCannotConfirmDeletion() async throws {
        let fixture = try await seed()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        try writeJournal(fixture.root, entries: [quarantine(fixture)])
        let raw = Data("{\"groups\":{\"byId\":{}},\"assets\":{\"byId\":{\"unfinished\":".utf8)
        try raw.write(to: fixture.root.appendingPathComponent("library/library.json"))
        let library = NativeLibrary(root: fixture.root)
        let list = try await library.invoke(command: "list_library_assets", args: [:])
        #expect(list["cleanupPending"]?.array.isEmpty == false)
        #expect(try Data(contentsOf: fixture.root.appendingPathComponent("library/library.json")) == raw)
        #expect(try Data(contentsOf: fixture.root.appendingPathComponent("library/assets/.trash/recovery")) == Data([1, 2, 3]))
        await #expect(throws: (any Error).self) { try await library.openMedia(id: fixture.id) }
    }

    /// Malformed journal data disables writes while preserving useful existing library reads and raw bytes.
    @Test func malformedJournalIsReadOnlyAndPreservesIndex() async throws {
        let fixture = try await seed()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let indexURL = fixture.root.appendingPathComponent("library/library.json")
        let old = try Data(contentsOf: indexURL)
        let raw = Data("{\"entries\":[{\"relPath\":\"../outside\"}]}".utf8)
        let journalURL = fixture.root.appendingPathComponent("library/asset-delete-journal.json")
        try raw.write(to: journalURL)
        let library = NativeLibrary(root: fixture.root)
        let list = try await library.invoke(command: "list_library_assets", args: [:])
        #expect(list["assets"]?["byId"]?[fixture.id] != nil)
        #expect(list["warnings"]?.array.isEmpty == false)
        await #expect(throws: (any Error).self) { try await library.invoke(command: "delete_library_asset", args: ["id": .string(fixture.id)]) }
        #expect(try Data(contentsOf: indexURL) == old)
        #expect(try Data(contentsOf: journalURL) == raw)
    }

    /// A damaged-index backup collision refuses import before another media file can be materialized.
    @Test func conflictingBackupDoesNotAccumulateOrphanMedia() async throws {
        let fixture = try await seed()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let raw = Data("{\"assets\":{\"byId\":{},\"broken\":".utf8)
        try raw.write(to: fixture.root.appendingPathComponent("library/library.json"))
        let digest = SHA256.hash(data: raw).map { String(format: "%02x", $0) }.joined()
        try Data([9]).write(to: fixture.root.appendingPathComponent("library/library-corrupt-" + digest + ".bak"))
        let directory = fixture.root.appendingPathComponent("library/assets")
        let before = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        let library = NativeLibrary(root: fixture.root)
        await #expect(throws: (any Error).self) { try await library.importAsset(name: "new.png", mime: "image/png", kind: "other", bytes: Data([5])) }
        #expect(try FileManager.default.contentsOfDirectory(atPath: directory.path) == before)
        #expect(try Data(contentsOf: fixture.root.appendingPathComponent("library/library.json")) == raw)
    }

    /// A normalized index over the §7.2 one-MiB budget is a partial view and cannot confirm a transaction committed.
    @Test func suspendedMigrationCannotRetireDeleteEvidence() async throws {
        let fixture = try await seed()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let entry = try quarantine(fixture)
        try writeJournal(fixture.root, entries: [entry])
        let item = HostJSON.object(["id": .string(""), "name": .string("x"), "kind": .string("other"),
            "relPath": .string(fixture.path), "mime": .string("image/png"), "createdAt": .number(0)])
        let old = HostJSON.object(["assets": .array(Array(repeating: item, count: 5_000)), "groups": .array([])])
        let raw = try JSONEncoder().encode(old)
        #expect(raw.count <= 1_048_576)
        try raw.write(to: fixture.root.appendingPathComponent("library/library.json"))
        let list = try await NativeLibrary(root: fixture.root).invoke(command: "list_library_assets", args: [:])
        #expect(list["warnings"]?.array.isEmpty == false)
        let journal = try JSONDecoder().decode(HostJSON.self, from: Data(contentsOf: fixture.root.appendingPathComponent("library/asset-delete-journal.json")))
        #expect(journal["entries"]?.array.count == 1)
        #expect(journal["entries"]?.array.first?["indexUncertain"] == .bool(true))
        #expect(journal["retainedCleanupCount"] == .number(0))
        #expect(try Data(contentsOf: fixture.root.appendingPathComponent("library/library.json")) == raw)
    }

    /// A conflict on one unrelated identity cannot block deleting another healthy library member.
    @Test func unrelatedConflictDoesNotBlockHealthyDeletion() async throws {
        let fixture = try await seed()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let library = NativeLibrary(root: fixture.root)
        let other = try await library.importAsset(name: "b.png", mime: "image/png", kind: "other", bytes: Data([9]))
        let otherFixture = Fixture(root: fixture.root, id: try #require(other["id"]?.string), path: try #require(other["relPath"]?.string))
        try writeJournal(fixture.root, entries: [quarantine(otherFixture)])
        try Data([5]).write(to: fixture.root.appendingPathComponent("library/" + otherFixture.path))
        let removed = try await library.invoke(command: "delete_library_asset", args: ["id": .string(fixture.id)])
        #expect(removed["id"]?.string == fixture.id)
        let listed = try await library.invoke(command: "list_library_assets", args: [:])
        #expect(listed["assets"]?["byId"]?[fixture.id] == nil)
        #expect(listed["assets"]?["byId"]?[otherFixture.id]?["conflicted"] == .bool(true))
        #expect(try Data(contentsOf: fixture.root.appendingPathComponent("library/assets/.trash/recovery")) == Data([9]))
    }

    /// An unrelated missing parent is isolated after recovery and cannot prevent restoring a healthy indexed asset.
    @Test func unrelatedMissingMediaDoesNotPoisonRecovery() async throws {
        let fixture = try await seed()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        try writeJournal(fixture.root, entries: [quarantine(fixture)])
        let url = fixture.root.appendingPathComponent("library/library.json")
        var fields = try #require(JSONDecoder().decode(HostJSON.self, from: Data(contentsOf: url)).object)
        var items = try #require(fields["assets"]?["byId"]?.object)
        items["missing"] = .object(["id": .string("missing"), "name": .string("missing"), "kind": .string("other"),
            "relPath": .string("assets/missing-directory/image.png"), "mime": .string("image/png"), "source": .string("upload"),
            "createdAt": .string(NativeAssetContract.timestamp()), "tags": .array([])])
        fields["assets"] = .object(["byId": .object(items)])
        try JSONEncoder().encode(HostJSON.object(fields)).write(to: url)
        let library = NativeLibrary(root: fixture.root)
        let list = try await library.invoke(command: "list_library_assets", args: [:])
        #expect(list["assets"]?["byId"]?["missing"] == nil)
        #expect(list["assets"]?["byId"]?[fixture.id]?["conflicted"] == nil)
        let file = try await library.openMedia(id: fixture.id)
        #expect(try file.read(maxBytes: 20) == Data([1, 2, 3]))
    }

    /// Fixture metadata retains an opaque path and the actual descriptor identity used by the persisted journal.
    private struct Fixture { let root: URL; let id: String; let path: String }

    /// Each case starts from the production import path so envelope/schema details cannot silently diverge.
    private func seed() async throws -> Fixture {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-native-recovery-" + UUID().uuidString)
        let asset = try await NativeLibrary(root: root).importAsset(name: "a.png", mime: "image/png", kind: "other", bytes: Data([1, 2, 3]))
        return Fixture(root: root, id: try #require(asset["id"]?.string), path: try #require(asset["relPath"]?.string))
    }

    /// Models a crash after identity-bound quarantine using the exact existing journal field contract.
    private func quarantine(_ fixture: Fixture) throws -> NativeLibraryJournal.Entry {
        let library = try NativeDirectory(root: fixture.root).directory("library")
        let file = try library.media(fixture.path, mime: "image/png")
        let trash = try library.directory("assets").directory(".trash", create: true)
        let (parent, leaf) = try library.mediaParent(fixture.path)
        try parent.move(leaf, to: trash, name: "recovery")
        return NativeLibraryJournal.Entry(id: "recovery", assetId: fixture.id, relPath: fixture.path, identity: file.identity, trashName: "assets/.trash/recovery")
    }

    /// Journal fixtures model external persisted state; assertions target recovery semantics rather than implementation layout.
    private func writeJournal(_ root: URL, entries: [NativeLibraryJournal.Entry]) throws {
        let encoded = try JSONEncoder().encode(entries)
        let value = Data("{\"retainedCleanupCount\":0,\"entries\":".utf8) + encoded + Data("}".utf8)
        try value.write(to: root.appendingPathComponent("library/asset-delete-journal.json"))
    }
}
