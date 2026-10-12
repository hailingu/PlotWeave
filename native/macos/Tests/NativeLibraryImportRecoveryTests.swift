import Darwin
import Foundation
import Testing
@testable import PlotWeaveNative

/// Imports exercise the real storage boundary using disposable roots and synthetic media only.
@MainActor
struct NativeLibraryImportRecoveryTests {
    /// A control directory that cannot commit an index must not accumulate finalized media on repeated retries.
    @Test func unwritableControlDirectoryDoesNotAccumulateUnindexedMedia() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-import-recovery-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let library = NativeLibrary(root: root)
        _ = try await library.importAsset(name: "old.png", mime: "image/png", kind: "other", bytes: Data([1]))
        let controls = root.appendingPathComponent("library")
        let assets = controls.appendingPathComponent("assets")
        let original = try Data(contentsOf: controls.appendingPathComponent("library.json"))
        let before = try FileManager.default.contentsOfDirectory(atPath: assets.path).sorted()
        #expect(chmod(controls.path, 0o500) == 0)
        defer { chmod(controls.path, 0o700) }
        for _ in 0..<3 {
            await #expect(throws: (any Error).self) {
                try await library.importAsset(name: "new.png", mime: "image/png", kind: "other", bytes: Data([2, 3]))
            }
        }
        #expect(try Data(contentsOf: controls.appendingPathComponent("library.json")) == original)
        #expect(try FileManager.default.contentsOfDirectory(atPath: assets.path).sorted() == before)
    }

    /// An actual index-path obstruction after media placement becomes visible retained cleanup on every recovery entry.
    @Test(arguments: ["list", "open", "source"])
    func indexFailureReconcilesOnceAcrossRestartAndRetry(entryPoint: String) async throws {
        let fixture = try await seed()
        defer { fixture.remove() }
        let blocked = NativeLibrary(root: fixture.root) { stage in
            if stage == .mediaCommitted {
                try FileManager.default.moveItem(at: fixture.indexURL, to: fixture.controls.appendingPathComponent("held-index"))
                try FileManager.default.createDirectory(at: fixture.indexURL, withIntermediateDirectories: false)
            }
        }
        await #expect(throws: (any Error).self) { try await fixture.importNew(blocked) }
        #expect(try fixture.mediaNames().count == 2)
        #expect(try fixture.journal()["entries"]?.array.first?["importPending"] == .bool(true))
        try FileManager.default.removeItem(at: fixture.indexURL)
        try FileManager.default.moveItem(at: fixture.controls.appendingPathComponent("held-index"), to: fixture.indexURL)
        let restarted = NativeLibrary(root: fixture.root)
        if entryPoint == "open" {
            #expect(try await restarted.openMedia(id: fixture.id).read(maxBytes: 10) == Data([1]))
        } else if entryPoint == "source" {
            #expect(try await restarted.source(id: fixture.id).1.read(maxBytes: 10) == Data([1]))
        }
        for _ in 0..<3 {
            let list = try await NativeLibrary(root: fixture.root).invoke("list_library_assets", args: [:])
            #expect(list["assets"]?["byId"]?.object?.count == 1)
            #expect(list["cleanupPending"]?.array.first?["count"] == .number(1))
            #expect(list["cleanupPending"]?.array.first?["bytes"] == .number(2))
        }
        let newAsset = try await fixture.importNew(restarted)
        #expect(try await restarted.openMedia(id: #require(newAsset["id"]?.string)).read(maxBytes: 10) == Data([2, 3]))
        #expect(try fixture.mediaNames().count == 2)
        #expect(try fixture.retainedBytes() == [Data([2, 3])])
    }

    /// The index rename has occurred but its directory barrier fails: restart must preserve the committed media.
    @Test func indexRenameFailureKeepsCommittedMediaAvailable() async throws {
        let fixture = try await seed()
        defer { fixture.remove() }
        let library = NativeLibrary(root: fixture.root) { stage in
            if stage == .indexRenamed { throw HostFailure(code: "PW_STORAGE_ERROR", message: "合成目录屏障故障") }
        }
        await #expect(throws: (any Error).self) { try await fixture.importNew(library) }
        let index = try JSONDecoder().decode(HostJSON.self, from: Data(contentsOf: fixture.indexURL))
        let newID = try #require(index["assets"]?["byId"]?.object?.keys.first { $0 != fixture.id })
        let restarted = NativeLibrary(root: fixture.root)
        #expect(try await restarted.openMedia(id: newID).read(maxBytes: 10) == Data([2, 3]))
        let list = try await restarted.invoke("list_library_assets", args: [:])
        #expect(list["assets"]?["byId"]?.object?.count == 2)
        #expect(list["cleanupPending"]?.array.isEmpty == true)
        #expect(try fixture.journal()["entries"]?.array.isEmpty == true)
        #expect(try fixture.retainedBytes().isEmpty)
    }

    /// Syntax damage or normalization that drops a member cannot prove an uncommitted import absent.
    @Test(arguments: [false, true])
    func incompleteIndexPreservesImportAndPausesWrites(malformedMember: Bool) async throws {
        let fixture = try await pendingImport()
        defer { fixture.remove() }
        let original = try Data(contentsOf: fixture.indexURL)
        let raw = malformedMember
            ? Data("{\"assets\":{\"byId\":{\"bad\":{\"id\":\"bad\"}}},\"groups\":{\"byId\":{}}}".utf8)
            : Data("{\"assets\":{\"byId\":{\"unfinished\":".utf8)
        try raw.write(to: fixture.indexURL)
        let library = NativeLibrary(root: fixture.root)
        let before = try fixture.mediaNames()
        let evidence = try Data(contentsOf: fixture.journalURL)
        for _ in 0..<2 {
            let list = try await library.invoke("list_library_assets", args: [:])
            #expect(list["cleanupPending"]?.array.first?["kind"] == .string("evidence"))
            await #expect(throws: (any Error).self) { try await fixture.importNew(library) }
        }
        #expect(try Data(contentsOf: fixture.indexURL) == raw)
        #expect(try Data(contentsOf: fixture.journalURL) == evidence)
        #expect(try fixture.mediaNames() == before)
        try original.write(to: fixture.indexURL)
        let list = try await library.invoke("list_library_assets", args: [:])
        #expect(list["cleanupPending"]?.array.first?["count"] == .number(1))
    }

    /// A later file or symlink at the import name is preserved with the original identity evidence.
    @Test(arguments: [false, true])
    func replacedMediaCannotRetireImportEvidence(symlink: Bool) async throws {
        let fixture = try await pendingImport()
        defer { fixture.remove() }
        let entry = try #require(fixture.journal()["entries"]?.array.first)
        let media = fixture.controls.appendingPathComponent(try #require(entry["relPath"]?.string))
        let retainedOriginal = fixture.controls.appendingPathComponent("held-original")
        try FileManager.default.moveItem(at: media, to: retainedOriginal)
        if symlink { try FileManager.default.createSymbolicLink(at: media, withDestinationURL: retainedOriginal) }
        else { try Data([9]).write(to: media) }
        let before = try Data(contentsOf: fixture.journalURL)
        let library = NativeLibrary(root: fixture.root)
        let list = try await library.invoke("list_library_assets", args: [:])
        #expect(list["cleanupPending"]?.array.first?["kind"] == .string("evidence"))
        await #expect(throws: (any Error).self) { try await fixture.importNew(library) }
        #expect(try Data(contentsOf: retainedOriginal) == Data([2, 3]))
        #expect(try Data(contentsOf: media) == (symlink ? Data([2, 3]) : Data([9])))
        #expect(try Data(contentsOf: fixture.journalURL) == before)
        #expect(try fixture.retainedBytes().isEmpty)
    }

    /// An active hard-link reference owns the same identity even when it uses a different path and asset ID.
    @Test func activeIdentityAtAnotherPathIsNeverQuarantined() async throws {
        let fixture = try await pendingImport()
        defer { fixture.remove() }
        let entry = try #require(fixture.journal()["entries"]?.array.first)
        let original = fixture.controls.appendingPathComponent(try #require(entry["relPath"]?.string))
        let alias = fixture.assets.appendingPathComponent("shared.png")
        try FileManager.default.linkItem(at: original, to: alias)
        var fields = try #require(JSONDecoder().decode(HostJSON.self, from: Data(contentsOf: fixture.indexURL)).object)
        var assets = try #require(fields["assets"]?["byId"]?.object)
        var shared = try #require(assets[fixture.id]?.object)
        shared["id"] = .string("shared")
        shared["relPath"] = .string("assets/shared.png")
        assets["shared"] = .object(shared)
        fields["assets"] = .object(["byId": .object(assets)])
        try JSONEncoder().encode(HostJSON.object(fields)).write(to: fixture.indexURL)
        try FileManager.default.removeItem(at: original)
        let library = NativeLibrary(root: fixture.root)
        #expect(try await library.source(id: "shared").1.read(maxBytes: 10) == Data([2, 3]))
        #expect(try fixture.journal()["entries"]?.array.isEmpty == true)
        #expect(try fixture.retainedBytes().isEmpty)
        #expect(try Data(contentsOf: alias) == Data([2, 3]))
    }

    /// A failed active-file read cannot silently rewrite the index and later turn a partial observation into proof.
    @Test func unavailableActiveReferencePreservesAuthoritativeIndex() async throws {
        let fixture = try await pendingImport()
        defer { fixture.remove() }
        var fields = try #require(JSONDecoder().decode(HostJSON.self, from: Data(contentsOf: fixture.indexURL)).object)
        var assets = try #require(fields["assets"]?["byId"]?.object)
        var missing = try #require(assets[fixture.id]?.object)
        missing["id"] = .string("missing")
        missing["relPath"] = .string("assets/missing.png")
        assets["missing"] = .object(missing)
        fields["assets"] = .object(["byId": .object(assets)])
        let raw = try JSONEncoder().encode(HostJSON.object(fields))
        try raw.write(to: fixture.indexURL)
        let evidence = try Data(contentsOf: fixture.journalURL)
        let names = try fixture.mediaNames()
        for _ in 0..<3 {
            let library = NativeLibrary(root: fixture.root)
            #expect(try await library.source(id: fixture.id).1.read(maxBytes: 10) == Data([1]))
            await #expect(throws: (any Error).self) { try await fixture.importNew(library) }
            #expect(try Data(contentsOf: fixture.indexURL) == raw)
            #expect(try Data(contentsOf: fixture.journalURL) == evidence)
            #expect(try fixture.mediaNames() == names)
        }
    }

    /// A reference created after an interrupted quarantine preserves the active file and still accounts for its extra retained name.
    @Test func activeReferenceAfterInterruptedQuarantineKeepsCleanupVisible() async throws {
        let fixture = try await pendingImport()
        defer { fixture.remove() }
        #expect(chmod(fixture.controls.path, 0o500) == 0)
        defer { chmod(fixture.controls.path, 0o700) }
        await #expect(throws: (any Error).self) { try await NativeLibrary(root: fixture.root).invoke("list_library_assets", args: [:]) }
        #expect(chmod(fixture.controls.path, 0o700) == 0)
        let entry = try #require(fixture.journal()["entries"]?.array.first)
        let retained = fixture.controls.appendingPathComponent(try #require(entry["trashName"]?.string))
        let alias = fixture.assets.appendingPathComponent("shared.png")
        try FileManager.default.linkItem(at: retained, to: alias)
        var fields = try #require(JSONDecoder().decode(HostJSON.self, from: Data(contentsOf: fixture.indexURL)).object)
        var assets = try #require(fields["assets"]?["byId"]?.object)
        var shared = try #require(assets[fixture.id]?.object)
        shared["id"] = .string("shared")
        shared["relPath"] = .string("assets/shared.png")
        assets["shared"] = .object(shared)
        fields["assets"] = .object(["byId": .object(assets)])
        try JSONEncoder().encode(HostJSON.object(fields)).write(to: fixture.indexURL)
        for _ in 0..<3 {
            let library = NativeLibrary(root: fixture.root)
            #expect(try await library.openMedia(id: "shared").read(maxBytes: 10) == Data([2, 3]))
            let list = try await library.invoke("list_library_assets", args: [:])
            #expect(list["cleanupPending"]?.array.first?["count"] == .number(1))
            #expect(list["cleanupPending"]?.array.first?["bytes"] == .number(2))
        }
        #expect(try fixture.retainedBytes() == [Data([2, 3])])
        #expect(try Data(contentsOf: alias) == Data([2, 3]))
    }

    /// Recovery may move media before its journal write fails; the persisted old entry folds exactly once on retry.
    @Test func recoveryJournalFailureRetainsEvidenceAndCountsOnce() async throws {
        let fixture = try await pendingImport()
        defer { fixture.remove() }
        let before = try Data(contentsOf: fixture.journalURL)
        #expect(chmod(fixture.controls.path, 0o500) == 0)
        defer { chmod(fixture.controls.path, 0o700) }
        let library = NativeLibrary(root: fixture.root)
        await #expect(throws: (any Error).self) { try await library.invoke("list_library_assets", args: [:]) }
        #expect(try fixture.mediaNames().count == 1)
        #expect(try fixture.retainedBytes() == [Data([2, 3])])
        #expect(try Data(contentsOf: fixture.journalURL) == before)
        #expect(chmod(fixture.controls.path, 0o700) == 0)
        for _ in 0..<3 {
            let list = try await NativeLibrary(root: fixture.root).invoke("list_library_assets", args: [:])
            #expect(list["cleanupPending"]?.array.first?["count"] == .number(1))
            #expect(list["cleanupPending"]?.array.first?["bytes"] == .number(2))
        }
    }

    /// Recording succeeds before exclusive placement, but a later failure leaves no final media to quarantine.
    @Test func failureAfterRecordingBeforePlacementRetiresWithoutCleanup() async throws {
        let fixture = try await seed()
        defer { fixture.remove() }
        let directory = try NativeDirectory(root: fixture.root).directory("library")
        #expect(throws: (any Error).self) {
            try directory.directory("assets").writeNew(Data([2, 3]), name: "la_interrupted.png", recordIdentity: { identity in
                try NativeLibraryJournal.beginImport(assetID: "la_interrupted", relative: "assets/la_interrupted.png", identity: identity, directory: directory)
                throw HostFailure(code: "PW_STORAGE_ERROR", message: "合成落位前故障")
            })
        }
        let list = try await NativeLibrary(root: fixture.root).invoke("list_library_assets", args: [:])
        #expect(list["assets"]?["byId"]?.object?.count == 1)
        #expect(list["cleanupPending"]?.array.isEmpty == true)
        #expect(try fixture.mediaNames().count == 1)
        #expect(try fixture.journal()["entries"]?.array.isEmpty == true)
    }

    /// Fixture methods inspect persisted semantics and exclude only the reserved private quarantine directory.
    private struct Fixture: Sendable {
        let root: URL
        let id: String
        var controls: URL { root.appendingPathComponent("library") }
        var indexURL: URL { controls.appendingPathComponent("library.json") }
        var journalURL: URL { controls.appendingPathComponent("asset-delete-journal.json") }
        var assets: URL { controls.appendingPathComponent("assets") }

        /// The production entry accepts bytes without any Web array or user-selected filesystem path.
        func importNew(_ library: NativeLibrary) async throws -> HostJSON {
            try await library.importAsset(name: "new.png", mime: "image/png", kind: "other", bytes: Data([2, 3]))
        }

        /// Journal inspection decodes the persisted wire shape rather than inspecting Swift implementation text.
        func journal() throws -> HostJSON { try JSONDecoder().decode(HostJSON.self, from: Data(contentsOf: journalURL)) }

        /// Finalized media names are observable independently of any in-memory service or asset list.
        func mediaNames() throws -> [String] { try FileManager.default.contentsOfDirectory(atPath: assets.path).filter { $0 != ".trash" }.sorted() }

        /// Retained bytes prove that convergence preserves media instead of silently deleting unindexed files.
        func retainedBytes() throws -> [Data] {
            let trash = assets.appendingPathComponent(".trash")
            return try FileManager.default.contentsOfDirectory(atPath: trash.path).sorted().map { try Data(contentsOf: trash.appendingPathComponent($0)) }
        }

        /// Verification output is deleted without touching user data or another task's roots.
        func remove() { try? FileManager.default.removeItem(at: root) }
    }

    /// A valid authoritative seed exercises the same import protocol as the failing subsequent operation.
    private func seed() async throws -> Fixture {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-import-recovery-" + UUID().uuidString)
        let asset = try await NativeLibrary(root: root).importAsset(name: "old.png", mime: "image/png", kind: "other", bytes: Data([1]))
        return Fixture(root: root, id: try #require(asset["id"]?.string))
    }

    /// A deterministic failure leaves the actual finalized media and durable identity record for restart tests.
    private func pendingImport() async throws -> Fixture {
        let fixture = try await seed()
        let library = NativeLibrary(root: fixture.root) { stage in
            if stage == .mediaCommitted { throw HostFailure(code: "PW_STORAGE_ERROR", message: "合成索引提交前故障") }
        }
        await #expect(throws: (any Error).self) { try await fixture.importNew(library) }
        return fixture
    }
}
