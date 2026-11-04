import Darwin
import Foundation
import Testing
@testable import PlotWeaveNative

/// Real index persistence with scoped media failures distinguishes missing from transient I/O (#883).
struct NativeLibraryMediaFailureTests {
    /// EMFILE/EIO fail only media validation; the actual operation still reads and owns library.json.
    @Test(arguments: [EMFILE, EIO])
    func transientErrorPreservesIndex(reason: Int32) async throws {
        let fixture = try await Fixture()
        defer { fixture.remove() }
        let before = try Data(contentsOf: fixture.indexURL)
        let operation = try NativeLibraryOperation(directory: NativeDirectory(root: fixture.libraryURL), validateMedia: { _, _, _ in
            errno = reason
            throw NativeDirectory.ioError("injected media open")
        })
        #expect(operation.index.assets[fixture.id] == fixture.asset)
        #expect(!operation.index.changed)
        #expect(!operation.index.warnings.isEmpty)
        #expect(try Data(contentsOf: fixture.indexURL) == before)
    }

    /// Real permission-denied open traverses NativeDirectory and the public list entry unchanged.
    @Test func unreadableMediaDoesNotRewriteIndex() async throws {
        let fixture = try await Fixture()
        defer { fixture.remove() }
        let before = try Data(contentsOf: fixture.indexURL)
        #expect(chmod(fixture.mediaURL.path, 0) == 0)
        defer { chmod(fixture.mediaURL.path, mode_t(S_IRUSR | S_IWUSR)) }
        let listing = try await fixture.library.invoke(command: "list_library_assets", args: [:])
        #expect(listing["assets"]?["byId"]?[fixture.id] == fixture.asset)
        #expect(listing["warnings"]?.array.isEmpty == false)
        #expect(try Data(contentsOf: fixture.indexURL) == before)
    }

    /// Confirmed ENOENT still isolates and persists the missing member, matching #851 semantics.
    @Test func missingMediaStillIsolates() async throws {
        let fixture = try await Fixture()
        defer { fixture.remove() }
        try FileManager.default.removeItem(at: fixture.mediaURL)
        let listing = try await fixture.library.invoke(command: "list_library_assets", args: [:])
        #expect(listing["assets"]?["byId"]?[fixture.id] == nil)
        let disk = try HostJSON.decode(Data(contentsOf: fixture.indexURL))
        #expect(disk["assets"]?["byId"]?[fixture.id] == nil)
    }

    /// Fixtures use real public imports and a fresh temporary root, never developer data.
    private struct Fixture {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-library-io-" + UUID().uuidString)
        let library: NativeLibrary
        let asset: HostJSON
        let id: String
        var libraryURL: URL { root.appendingPathComponent("library") }
        var indexURL: URL { libraryURL.appendingPathComponent("library.json") }
        var mediaURL: URL { libraryURL.appendingPathComponent(asset["relPath"]?.string ?? "invalid") }
        init() async throws {
            library = NativeLibrary(root: root)
            let imported = try await library.invoke(command: "import_library_asset", args: ["name": .string("fixture"), "mime": .string("image/png"), "kind": .string("other"), "bytes": .array([.number(7)])])
            id = try #require(imported["id"]?.string)
            let listing = try await library.invoke(command: "list_library_assets", args: [:])
            asset = try #require(listing["assets"]?["byId"]?[id])
        }
        func remove() { try? FileManager.default.removeItem(at: root) }
    }
}
