import Foundation
import Testing
@testable import PlotWeaveNative

/// Delete boundaries mirror dev's advisory totals repair and pre-recovery half-budget contract.
@MainActor
struct NativeLibraryJournalBoundaryTests {
    /// Invalid counts invalidate their associated bytes in both object journals and legacy side archives.
    @Test func invalidCleanupCountDiscardsUnprovenBytes() async throws {
        for legacy in [false, true] {
            for invalidCount in [HostJSON.string("bad"), .number(Double(UInt32.max) + 1)] {
                let fixture = try await seed()
                defer { try? FileManager.default.removeItem(at: fixture.root) }
                var fields: [String: HostJSON] = ["retainedCleanupCount": invalidCount, "trashBytes": .number(99)]
                if !legacy { fields["entries"] = .array([]) }
                let name = legacy ? "asset-delete-archive.json" : "asset-delete-journal.json"
                try JSONEncoder().encode(HostJSON.object(fields)).write(to: fixture.root.appendingPathComponent("library/" + name))
                let library = NativeLibrary(root: fixture.root)
                _ = try await library.invoke("delete_library_asset", args: ["id": .string(fixture.id)])
                let result = try await library.invoke("list_library_assets", args: [:])
                let summary = try #require(result["cleanupPending"]?.array.first)
                #expect(summary["count"] == .number(1))
                #expect(summary["bytes"] == .number(3))
            }
        }
    }

    /// Delete refuses before a recoverable large entry can be retired or the index/media can change.
    @Test func oversizedDeleteJournalRefusesBeforeRecovery() async throws {
        let fixture = try await seed()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let directory = try NativeDirectory(root: fixture.root).directory("library")
        let entry = try paddedEntry(fixture, directory: directory, encodedBytes: 540_000)
        let raw = try journalData(entry)
        #expect(raw.count > 524_288 && raw.count <= 1_048_576)
        let journalURL = fixture.root.appendingPathComponent("library/asset-delete-journal.json")
        let indexURL = fixture.root.appendingPathComponent("library/library.json")
        let beforeIndex = try Data(contentsOf: indexURL)
        try raw.write(to: journalURL)
        let library = NativeLibrary(root: fixture.root)
        do {
            _ = try await library.invoke("delete_library_asset", args: ["id": .string(fixture.id)])
            Issue.record("Delete must refuse the half-budget journal before recovery")
        } catch let failure as HostFailure { #expect(failure.code == "PW_STORAGE_REFUSED") }
        #expect(try Data(contentsOf: journalURL) == raw)
        #expect(try Data(contentsOf: indexURL) == beforeIndex)
        #expect(try Data(contentsOf: fixture.root.appendingPathComponent("library/" + fixture.path)) == Data([1, 2, 3]))
    }

    /// Appending a transaction must retain half-budget headroom before any durable record or media move.
    @Test func appendedTransactionReservesHeadroom() async throws {
        let fixture = try await seed()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let directory = try NativeDirectory(root: fixture.root).directory("library")
        let entry = try paddedEntry(fixture, directory: directory, encodedBytes: 524_250)
        let raw = try journalData(entry)
        #expect(raw.count <= 524_288)
        let journalURL = fixture.root.appendingPathComponent("library/asset-delete-journal.json")
        try raw.write(to: journalURL)
        var journal = NativeLibraryJournal(directory: directory)
        #expect(!journal.readOnly)
        do {
            _ = try journal.quarantine(assetID: fixture.id, relative: fixture.path, directory: directory)
            Issue.record("Appending a transaction must reserve half-budget headroom")
        } catch let failure as HostFailure { #expect(failure.code == "PW_STORAGE_REFUSED") }
        #expect(try Data(contentsOf: journalURL) == raw)
        #expect(try directory.media(fixture.path, mime: "image/png").read(maxBytes: 20) == Data([1, 2, 3]))
    }

    /// Import reserves the same bounded journal before its media rename even when unrelated conflicts occupy capacity.
    @Test func oversizedImportJournalRefusesBeforeMediaPlacement() async throws {
        let fixture = try await seed()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let directory = try NativeDirectory(root: fixture.root).directory("library")
        let entry = try paddedEntry(fixture, directory: directory, encodedBytes: 540_000)
        try directory.directory("assets").directory(".trash", create: true).writeNew(Data([9]), name: "test")
        let raw = try journalData(entry)
        let journalURL = fixture.root.appendingPathComponent("library/asset-delete-journal.json")
        let indexURL = fixture.root.appendingPathComponent("library/library.json")
        let beforeIndex = try Data(contentsOf: indexURL)
        try raw.write(to: journalURL)
        let library = NativeLibrary(root: fixture.root)
        do {
            _ = try await library.importAsset(name: "new.png", mime: "image/png", kind: "other", bytes: Data([4]))
            Issue.record("Import must reserve bounded recovery evidence before finalized media")
        } catch let failure as HostFailure { #expect(failure.code == "PW_STORAGE_REFUSED") }
        #expect(try directory.directory("assets").entries().filter { $0 != ".trash" }.count == 1)
        #expect(try Data(contentsOf: journalURL) == raw)
        #expect(try Data(contentsOf: indexURL) == beforeIndex)
        #expect(try directory.media(fixture.path, mime: "image/png").read(maxBytes: 20) == Data([1, 2, 3]))
    }

    /// Fixtures start through real import so schema validation and filesystem identities are authoritative.
    private struct Fixture { let root: URL; let id: String; let path: String }

    /// No test selects or accesses the user's application-data directory.
    private func seed() async throws -> Fixture {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-native-journal-boundary-" + UUID().uuidString)
        let asset = try await NativeLibrary(root: root).importAsset(name: "a.png", mime: "image/png", kind: "other", bytes: Data([1, 2, 3]))
        return Fixture(root: root, id: try #require(asset["id"]?.string), path: try #require(asset["relPath"]?.string))
    }

    /// Padding is itself a valid transaction identity, allowing the budget test to reach the semantic guard.
    private func paddedEntry(_ fixture: Fixture, directory: NativeDirectory, encodedBytes: Int) throws -> NativeLibraryJournal.Entry {
        let identity = try directory.media(fixture.path, mime: "image/png").identity
        let base = NativeLibraryJournal.Entry(id: "t", assetId: fixture.id, relPath: fixture.path, identity: identity, trashName: "assets/.trash/test")
        let extra = encodedBytes - (try journalData(base).count)
        return NativeLibraryJournal.Entry(id: String(repeating: "t", count: extra + 1), assetId: fixture.id, relPath: fixture.path,
            identity: identity, trashName: "assets/.trash/test")
    }

    /// The persisted fixture uses the dev journal wire shape, not implementation text assertions.
    private func journalData(_ entry: NativeLibraryJournal.Entry) throws -> Data {
        let encoded = try JSONEncoder().encode([entry])
        return Data("{\"retainedCleanupCount\":0,\"entries\":".utf8) + encoded + Data("}".utf8)
    }
}
