import Darwin
import Foundation
import Testing
@testable import PlotWeaveNative

/// Issue #851: Swift and Rust evaluate the same physical library media availability corpus.
struct NativeLibraryMediaVectorTests {
    /// Unavailable entries never enter the usable list, while healthy and outside bytes survive.
    @Test func sharedLibraryMediaVectors() async throws {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("crates/plotweave-core/testdata/asset-contract.json")
        let vectors = try JSONDecoder().decode(HostJSON.self, from: Data(contentsOf: file))
        let rows = try #require(vectors["libraryMedia"]?.arrayValue)
        #expect(!rows.isEmpty)
        for row in rows {
            let id = try #require(row["id"]?.string)
            let path = try #require(row["relPath"]?.string)
            let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-media-vector-" + UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: root) }
            let directory = root.appendingPathComponent("library")
            try prepare(directory, kind: id)
            try Data("healthy".utf8).write(to: directory.appendingPathComponent("assets/healthy.png"))
            let index: HostJSON = .object(["assets": .object(["byId": .object([
                id: asset(id, path: path), "healthy": asset("healthy", path: "assets/healthy.png")
            ])]), "groups": .object(["byId": .object([:])])])
            try JSONEncoder().encode(index).write(to: directory.appendingPathComponent("library.json"))
            let library = NativeLibrary(root: root)
            let listed = try await library.invoke(command: "list_library_assets", args: [:])
            #expect(HostJSON.bool(listed["assets"]?["byId"]?[id] != nil) == row["available"], "\(id)")
            #expect(listed["assets"]?["byId"]?["healthy"] != nil)
            #expect(HostJSON.bool(listed["warnings"]?.array.isEmpty == true) == row["available"], "\(id)")
            #expect(try Data(contentsOf: directory.appendingPathComponent("assets/healthy.png")) == Data("healthy".utf8))
            #expect(try Data(contentsOf: directory.appendingPathComponent("outside/media.png")) == Data("outside".utf8))
        }
    }

    /// Raw entries are intentionally built independently from production normalization.
    private func asset(_ id: String, path: String) -> HostJSON {
        .object(["id": .string(id), "name": .string(id), "kind": .string("other"), "mime": .string("image/png"),
                 "relPath": .string(path), "source": .string("upload"), "createdAt": .string("2026-01-01T00:00:00.000Z"), "tags": .array([])])
    }

    /// Physical nodes retain their exact type; FIFO setup never opens or waits for a writer.
    private func prepare(_ directory: URL, kind: String) throws {
        let files = FileManager.default
        try files.createDirectory(at: directory.appendingPathComponent("assets"), withIntermediateDirectories: true)
        try files.createDirectory(at: directory.appendingPathComponent("outside"), withIntermediateDirectories: true)
        try Data("outside".utf8).write(to: directory.appendingPathComponent("outside/media.png"))
        let target = directory.appendingPathComponent("assets/media.png")
        switch kind {
        case "regular": try Data("media".utf8).write(to: target)
        case "nested-regular":
            try files.createDirectory(at: directory.appendingPathComponent("assets/nested"), withIntermediateDirectories: true)
            try Data("media".utf8).write(to: directory.appendingPathComponent("assets/nested/media.png"))
        case "missing", "parent-missing": break
        case "symlink": try files.createSymbolicLink(atPath: target.path, withDestinationPath: "../outside/media.png")
        case "directory": try files.createDirectory(at: target, withIntermediateDirectories: true)
        case "fifo": #expect(mkfifo(target.path, 0o600) == 0)
        case "parent-symlink": try files.createSymbolicLink(atPath: directory.appendingPathComponent("assets/nested").path, withDestinationPath: "../outside")
        case "parent-file": try Data("file".utf8).write(to: directory.appendingPathComponent("assets/nested"))
        default: Issue.record("Unknown shared media vector: \(kind)")
        }
    }
}
