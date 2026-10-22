import Foundation
import Testing
@testable import PlotWeaveNative

/// Asset integration verifies copied and pending bytes without opening any application-support directory.
@MainActor
struct NativeAssetsTests {
    /// Library import returns a different project identity and remains readable before the document debounce save.
    @Test func libraryCopyIsIndependentAndPendingMediaIsReadable() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-native-assets-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let library = NativeLibrary(root: root)
        let projects = NativeProjectStore(root: root)
        let assets = NativeAssets(library: library, projects: projects)
        let project = try await projects.invoke(command: "create_project", args: ["name": .string("项目")])
        let id = try #require(project["id"]?.string)
        let source = try await library.importAsset(name: "参考.png", mime: "image/png", kind: "reference", bytes: Data([7, 8, 9]))
        let sourceID = try #require(source["id"]?.string)
        let copied = try await assets.invoke(command: "import_project_asset_from_library", args: ["id": .string(id), "libraryAssetId": .string(sourceID)])
        let copiedID = try #require(copied["id"]?.string)
        #expect(copiedID != sourceID)
        #expect(copied["source"]?.string == "upload")
        let validated = try await assets.invoke(command: "validate_project_asset", args: ["id": .string(id), "asset": copied])
        #expect(validated == copied)
        _ = try await library.invoke(command: "delete_library_asset", args: ["id": .string(sourceID)])
        let opaque = try await assets.invoke(command: "get_asset_media_url", args: ["scope": .object(["kind": .string("project"), "projectId": .string(id)]), "assetId": .string(copiedID)])
        let url = try #require(opaque.string.flatMap(URL.init(string:)))
        let (file, maximum) = try await assets.open(url: url)
        #expect(try file.read(maxBytes: maximum) == Data([7, 8, 9]))
        _ = try await projects.invoke(command: "delete_project", args: ["id": .string(id)])
        await #expect(throws: (any Error).self) { try await assets.open(url: url) }
    }

    /// Scope and URI boundaries cannot turn Web-provided names into host filesystem authority.
    @Test func untrustedScopesAndMediaURLsAreRejected() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-native-assets-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let assets = NativeAssets(library: NativeLibrary(root: root), projects: NativeProjectStore(root: root))
        for scope in [HostJSON.object(["kind": .string("library"), "path": .string("/tmp/private")]), .object(["kind": .string("project"), "projectId": .string("../outside")]), .object(["kind": .string("file")])] {
            await #expect(throws: (any Error).self) { try await assets.invoke(command: "get_asset_media_url", args: ["scope": scope, "assetId": .string("a")]) }
        }
        for raw in ["file:///tmp/private", "pwmedia://elsewhere/library/a", "pwmedia://localhost/library/a/b", "pwmedia://localhost/project/p/2e2e2f", "pwmedia://localhost/project/p/zz", "pwmedia://localhost/library/%61"] {
            await #expect(throws: (any Error).self) { try await assets.open(url: #require(URL(string: raw))) }
        }
    }
}
