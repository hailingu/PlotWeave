import Foundation
import Testing
@testable import PlotWeaveNative

/// Temporary-root native library exercises persisted outcomes rather than transport mocks.
@MainActor
struct NativeLibraryTests {
    /// Imports, metadata and group transitions preserve media and never leave dangling membership.
    @Test func libraryCrudPersistsMediaAndAtomicGroupMembership() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-native-library-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let library = NativeLibrary(root: root)
        let imported = try await library.invoke(command: "import_library_asset", args: [
            "name": .string("参考.png"), "mime": .string(" Image/PNG "), "kind": .string("character"),
            "bytes": .array([.number(1), .number(2), .number(3)])
        ])
        let id = try #require(imported["id"]?.string)
        #expect(imported["mime"]?.string == "image/png")
        #expect(imported["source"]?.string == "upload")
        let group = HostJSON.object(["id": .string("group"), "name": .string(" 女主 "), "kind": .string("character")])
        _ = try await library.invoke(command: "upsert_library_group", args: ["group": group])
        _ = try await library.invoke(command: "update_library_asset", args: ["id": .string(id), "patch": .object([
            "name": .string(" 林晚 "), "tags": .array([.string("  夜景 ")]), "view": .string("front"), "groupId": .string("group")
        ])])
        let grouped = try await library.invoke(command: "list_library_assets", args: [:])
        #expect(grouped["assets"]?["byId"]?[id]?["name"]?.string == "林晚")
        #expect(grouped["assets"]?["byId"]?[id]?["groupId"]?.string == "group")
        #expect(grouped["groups"]?["byId"]?["group"]?["name"]?.string == "女主")
        #expect(grouped["diagnosticsRevision"]?.string != imported["diagnosticsRevision"]?.string)
        _ = try await library.invoke(command: "delete_library_group", args: ["id": .string("group")])
        let ungrouped = try await library.invoke(command: "list_library_assets", args: [:])
        #expect(ungrouped["assets"]?["byId"]?[id]?["groupId"] == nil)
        _ = try await library.invoke(command: "delete_library_asset", args: ["id": .string(id)])
        let removed = try await library.invoke(command: "list_library_assets", args: [:])
        #expect(removed["assets"]?["byId"]?[id] == nil)
        #expect(removed["cleanupPending"]?.array.isEmpty == false)
        let files = try FileManager.default.contentsOfDirectory(at: root.appendingPathComponent("library/assets/.trash"), includingPropertiesForKeys: nil)
        #expect(files.count == 1)
        #expect(try Data(contentsOf: files[0]) == Data([1, 2, 3]))
        let reopened = NativeLibrary(root: root)
        let afterRestart = try await reopened.invoke(command: "list_library_assets", args: [:])
        #expect(afterRestart["assets"]?["byId"]?[id] == nil)
        #expect(afterRestart["cleanupPending"] == removed["cleanupPending"])
    }

    /// A conflicting group kind or an invalid patch must leave the last good persisted asset untouched.
    @Test func rejectedPatchDoesNotChangePersistedIndex() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-native-library-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let library = NativeLibrary(root: root)
        let asset = try await library.invoke(command: "import_library_asset", args: ["name": .string("a.png"), "mime": .string("image/png"), "kind": .string("character"), "bytes": .array([.number(1)])])
        let id = try #require(asset["id"]?.string)
        _ = try await library.invoke(command: "upsert_library_group", args: ["group": .object(["id": .string("g"), "name": .string("角色"), "kind": .string("character")])])
        _ = try await library.invoke(command: "update_library_asset", args: ["id": .string(id), "patch": .object(["groupId": .string("g")])])
        for patch in [HostJSON.object(["kind": .string("location")]), .object(["relPath": .string("assets/other")]), .object(["tags": .array([.string("x"), .string(" x ")])])] {
            await #expect(throws: (any Error).self) { try await library.invoke(command: "update_library_asset", args: ["id": .string(id), "patch": patch]) }
        }
        await #expect(throws: (any Error).self) {
            try await library.invoke(command: "upsert_library_group", args: ["group": .object(["id": .string("g"), "name": .string("不应写入"), "kind": .string("location")])])
        }
        let index = try await library.invoke(command: "list_library_assets", args: [:])
        #expect(index["assets"]?["byId"]?[id]?["kind"]?.string == "character")
        #expect(index["groups"]?["byId"]?["g"]?["name"]?.string == "角色")
    }

    /// Syntactically damaged indices retain complete members and bytes until a durable repair backup exists.
    @Test func damagedIndexKeepsHealthyEntryAndBacksUpBeforeWrite() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-native-library-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let library = NativeLibrary(root: root)
        let asset = try await library.invoke(command: "import_library_asset", args: ["name": .string("a.png"), "mime": .string("image/png"), "kind": .string("other"), "bytes": .array([.number(7)])])
        let id = try #require(asset["id"]?.string)
        let entry = try JSONEncoder().encode(asset)
        let raw = Data("{\"groups\":{\"byId\":{}},\"assets\":{\"byId\":{\"\(id)\":".utf8) + entry + Data(",\"broken\":{\"name\":".utf8)
        let file = root.appendingPathComponent("library/library.json")
        try raw.write(to: file)
        let repairedView = try await library.invoke(command: "list_library_assets", args: [:])
        #expect(repairedView["assets"]?["byId"]?[id] != nil)
        #expect(repairedView["warnings"]?.array.isEmpty == false)
        #expect(try Data(contentsOf: file) == raw)
        _ = try await library.invoke(command: "update_library_asset", args: ["id": .string(id), "patch": .object(["name": .string("恢复后")])])
        let backups = try FileManager.default.contentsOfDirectory(at: root.appendingPathComponent("library"), includingPropertiesForKeys: nil).filter { $0.lastPathComponent.hasPrefix("library-corrupt-") }
        #expect(backups.count == 1)
        #expect(try Data(contentsOf: backups[0]) == raw)
        #expect(try Data(contentsOf: file) != raw)
    }

    /// An untrusted asset directory cannot expose outside bytes or turn a first import into an index write.
    @Test func symlinkedAssetsRejectBeforeIndexMutation() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-native-library-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root.appendingPathComponent("library"), withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("library/assets"), withDestinationURL: root)
        let library = NativeLibrary(root: root)
        await #expect(throws: (any Error).self) {
            try await library.invoke(command: "import_library_asset", args: ["name": .string("a.png"), "mime": .string("image/png"), "kind": .string("other"), "bytes": .array([.number(1)])])
        }
        #expect(!FileManager.default.fileExists(atPath: root.appendingPathComponent("library/library.json").path))
    }
}
