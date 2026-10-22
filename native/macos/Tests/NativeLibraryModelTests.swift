import Darwin
import Foundation
import Testing
@testable import PlotWeaveNative

/// Native presentation is verified against real selected files and the authoritative persisted library.
@MainActor
struct NativeLibraryModelTests {
    /// Selected special files are rejected without waiting for a writer, while prior imports remain authoritative.
    @Test(arguments: ["fifo", "directory", "symlink"], [false, true])
    func selectedSpecialFilesNeverBlockImport(kind: String, includePrior: Bool) async throws {
        let fixture = try Fixture()
        let special = fixture.root.appendingPathComponent("special.png")
        switch kind {
        case "fifo": try #require(special.path.withCString { mkfifo($0, mode_t(S_IRUSR | S_IWUSR)) } == 0)
        case "directory": try FileManager.default.createDirectory(at: special, withIntermediateDirectories: false)
        default: try FileManager.default.createSymbolicLink(at: special, withDestinationURL: fixture.second)
        }
        let model = NativeLibraryModel(library: fixture.library, selectFiles: { includePrior ? [fixture.first, special] : [special] })
        defer { model.close(); fixture.remove() }
        try await load(model)
        model.pickFiles(kind: "other")
        let deadline = ContinuousClock.now.advanced(by: .seconds(2))
        while model.busy, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(5)) }
        let blocked = model.busy
        // The old blocking FIFO open must be released even when the regression fails; no orphan thread survives teardown.
        if blocked, kind == "fifo" {
            let writer = special.path.withCString { open($0, O_RDWR | O_NONBLOCK | O_CLOEXEC) }
            try #require(writer >= 0)
            defer { Darwin.close(writer) }
            try await settle(model)
        }
        #expect(!blocked, "所选特殊文件不得等待 writer 才拒绝")
        #expect(model.error != nil && model.writable)
        let authoritative = try await fixture.library.invoke(command: "list_library_assets", args: [:])
        #expect(model.value["assets"] == authoritative["assets"])
        let entries = try #require(authoritative["assets"]?["byId"]?.object)
        #expect(entries.count == (includePrior ? 1 : 0))
        if includePrior {
            let media = try await fixture.library.openMedia(id: try #require(entries.keys.first))
            #expect(try media.read(maxBytes: 10) == Data([1, 2]))
        }
    }

    /// Later read or import failure must retain the already-committed file in the visible library snapshot.
    @Test(arguments: ["missing.png", "empty.png"])
    func partialImportPublishesCommittedAssets(failingName: String) async throws {
        let fixture = try Fixture()
        let model = NativeLibraryModel(library: fixture.library, selectFiles: { [fixture.first, fixture.root.appendingPathComponent(failingName)] })
        defer { model.close(); fixture.remove() }
        try await load(model)
        model.pickFiles(kind: "other")
        try await settle(model)
        let authoritative = try await fixture.library.invoke(command: "list_library_assets", args: [:])
        #expect(model.value["assets"] == authoritative["assets"])
        let assets = try #require(model.value["assets"]?["byId"]?.object)
        #expect(assets.count == 1 && model.error != nil && model.writable)
        let id = try #require(assets.keys.first)
        let media = try await NativeLibrary(root: fixture.root).openMedia(id: id)
        #expect(try media.read(maxBytes: 10) == Data([1, 2]))
    }

    /// A complete selection imports each file once; cancelling the native selection imports none.
    @Test(arguments: [true, false]) func successAndCancelledSelection(supplied: Bool) async throws {
        let fixture = try Fixture()
        let model = NativeLibraryModel(library: fixture.library, selectFiles: { supplied ? [fixture.first, fixture.second] : [] })
        defer { model.close(); fixture.remove() }
        try await load(model)
        model.pickFiles(kind: "other")
        try await settle(model)
        #expect(model.value["assets"]?["byId"]?.object?.count == (supplied ? 2 : 0))
        #expect(model.error == nil && model.writable)
        let persisted = try await NativeLibrary(root: fixture.root).invoke(command: "list_library_assets", args: [:])
        #expect(model.value["assets"] == persisted["assets"])
    }

    /// Failed recovery preserves the last good snapshot and reports both failures instead of a fake empty list.
    @Test func failedRecoveryRetainsLastGoodSnapshot() async throws {
        let fixture = try Fixture()
        _ = try await fixture.library.importAsset(name: "seed.png", mime: "image/png", kind: "other", bytes: Data([3]))
        let model = NativeLibraryModel(library: fixture.library, selectFiles: {
            try FileManager.default.moveItem(at: fixture.root.appendingPathComponent("library"), to: fixture.root.appendingPathComponent("held-library"))
            try Data([0]).write(to: fixture.root.appendingPathComponent("library"))
            return [fixture.root.appendingPathComponent("missing.png")]
        })
        defer { model.close(); fixture.remove() }
        try await load(model)
        let before = model.value
        model.pickFiles(kind: "other")
        try await settle(model)
        #expect(model.value == before)
        #expect(model.error?.contains("\n") == true && model.writable)
    }

    /// Another mutation entry point must also reread authoritative assets after a failed write.
    @Test func failedMutationRefreshesAuthoritativeList() async throws {
        let fixture = try Fixture()
        let model = NativeLibraryModel(library: fixture.library)
        defer { model.close(); fixture.remove() }
        try await load(model)
        _ = try await fixture.library.importAsset(name: "external.png", mime: "image/png", kind: "other", bytes: Data([4]))
        model.mutate("update_library_asset", args: ["id": .string("missing"), "patch": .object(["name": .string("changed")])])
        try await settle(model)
        let authoritative = try await fixture.library.invoke(command: "list_library_assets", args: [:])
        #expect(model.value["assets"] == authoritative["assets"])
        #expect(model.value["assets"]?["byId"]?.object?.count == 1 && model.error != nil)
    }

    /// Closing while native selection is pending revokes late UI updates and prevents importing returned files.
    @Test func closedSelectionCannotPublishOrImportLateFiles() async throws {
        let fixture = try Fixture()
        var resume: CheckedContinuation<[URL], Never>?
        var returned = false
        let model = NativeLibraryModel(library: fixture.library, selectFiles: {
            let urls = await withCheckedContinuation { resume = $0 }
            returned = true
            return urls
        })
        defer { model.close(); fixture.remove() }
        try await load(model)
        let before = model.value
        model.pickFiles(kind: "other")
        try await wait { resume != nil }
        model.close()
        resume?.resume(returning: [fixture.first])
        try await wait { returned }
        let persisted = try await fixture.library.invoke(command: "list_library_assets", args: [:])
        #expect(persisted["assets"]?["byId"]?.object?.isEmpty == true)
        #expect(model.value == before && model.error == nil)
    }

    /// Polling observes the model's completed task, not a guessed amount of time for storage to finish.
    private func settle(_ model: NativeLibraryModel) async throws {
        try await wait { !model.busy }
    }

    /// A bounded predicate observes selection and task events without timing the production operation.
    private func wait(_ predicate: () -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while !predicate(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(5)) }
        try #require(predicate())
    }

    /// Writes are enabled only after an actual successful initial library read.
    private func load(_ model: NativeLibraryModel) async throws {
        model.refresh()
        try await settle(model)
        try #require(model.writable && model.error == nil)
    }

    /// Selected files and app data live in a single disposable root owned by this test.
    private struct Fixture {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-library-model-" + UUID().uuidString)
        let library: NativeLibrary
        var first: URL { root.appendingPathComponent("first.png") }
        var second: URL { root.appendingPathComponent("second.png") }
        /// The empty regular file exercises a later import rejection separately from a missing-file read.
        init() throws {
            library = NativeLibrary(root: root)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            try Data([1, 2]).write(to: first)
            try Data([5]).write(to: second)
            try Data().write(to: root.appendingPathComponent("empty.png"))
        }
        /// Model work settles before this root is removed, so no task can mutate another test's data.
        func remove() { try? FileManager.default.removeItem(at: root) }
    }
}
