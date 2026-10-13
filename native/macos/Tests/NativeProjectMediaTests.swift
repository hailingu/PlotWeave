import Foundation
import Synchronization
import Testing
@testable import PlotWeaveNative

/// Actual project media proves pending visibility, disk authority, alias removal and deletion barriers.
struct NativeProjectMediaTests {
    /// Imported bytes are repeatably visible before debounce; deleted projects never resolve old pending refs.
    @Test func pendingMediaRemainsVisibleUntilSaveButCannotResurrectDeletedProject() async throws {
        let fixture = Fixture()
        defer { fixture.remove() }
        let meta = try await fixture.store.invoke(command: "create_project", args: ["name": .string("媒体剧")])
        let id = try #require(meta["id"]?.string)
        let bytes = Data([0x89, 0x50, 0x4e, 0x47])
        let asset = try await fixture.store.importMedia(id: id, bytes: bytes, mime: "image/png", source: "generated", extension: "png")
        let assetId = try #require(asset["id"]?.string)
        #expect(try await fixture.store.openMedia(id: id, assetId: assetId).read(maxBytes: 1024) == bytes)
        #expect(try await fixture.store.openMedia(id: id, assetId: assetId).read(maxBytes: 1024) == bytes)
        var doc = try #require(try await fixture.store.invoke(command: "load_project", args: ["id": .string(id)]).object)
        #expect(doc["assets"]?["byId"]?.object == [:])
        doc["assets"] = .object(["byId": .object([assetId: asset])])
        _ = try await fixture.store.invoke(command: "save_project", args: ["id": .string(id), "doc": .object(doc), "expectExisting": .bool(true)])
        #expect(try await fixture.store.openMedia(id: id, assetId: assetId).read(maxBytes: 1024) == bytes)
        _ = try await fixture.store.invoke(command: "delete_project", args: ["id": .string(id)])
        await #expect(throws: HostFailure.self) { try await fixture.store.openMedia(id: id, assetId: assetId) }
        await #expect(throws: HostFailure.self) {
            try await fixture.store.importMedia(id: id, bytes: bytes, mime: "image/png", source: "generated", extension: "png")
        }
        #expect(!FileManager.default.fileExists(atPath: fixture.root.appendingPathComponent("projects/" + id).path))
    }

    /// Alias resolution rereads the current blank-key entry and never revives it after its authoritative removal.
    @Test func repairedOpaqueAliasCannotReviveRemovedAsset() async throws {
        let fixture = Fixture()
        defer { fixture.remove() }
        let meta = try await fixture.store.invoke(command: "create_project", args: ["name": .string("别名剧")])
        let id = try #require(meta["id"]?.string)
        let bytes = Data([1, 2, 3])
        let asset = try await fixture.store.importMedia(id: id, bytes: bytes, mime: "image/png", source: "upload", extension: "png")
        var doc = try #require(try await fixture.store.invoke(command: "load_project", args: ["id": .string(id)]).object)
        doc["assets"] = .object(["byId": .object([" ": asset])])
        let path = fixture.root.appendingPathComponent("projects/" + id + ".json")
        try JSONEncoder().encode(HostJSON.object(doc)).write(to: path)
        let repaired = "重发/opaque%身份"
        try await fixture.store.registerAlias(id: id, blankKey: " ", freshId: repaired)
        #expect(try await fixture.store.openMedia(id: id, assetId: repaired).read(maxBytes: 1024) == bytes)
        doc["assets"] = .object(["byId": .object([:])])
        try JSONEncoder().encode(HostJSON.object(doc)).write(to: path)
        await #expect(throws: HostFailure.self) { try await fixture.store.openMedia(id: id, assetId: repaired) }
    }

    /// Neither invalid asset metadata nor a symlinked project directory can commit or serve outside bytes.
    @Test func projectMediaRefusesUnsafePathAndSymlinkTree() async throws {
        let fixture = Fixture()
        defer { fixture.remove() }
        let meta = try await fixture.store.invoke(command: "create_project", args: ["name": .string("安全剧")])
        let id = try #require(meta["id"]?.string)
        let outside = fixture.root.appendingPathComponent("outside")
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        let linked = fixture.root.appendingPathComponent("projects/" + id)
        try FileManager.default.createSymbolicLink(at: linked, withDestinationURL: outside)
        await #expect(throws: HostFailure.self) {
            try await fixture.store.importMedia(id: id, bytes: Data([8]), mime: "image/png", source: "upload", extension: "png")
        }
        #expect(try FileManager.default.contentsOfDirectory(atPath: outside.path).isEmpty)
    }

    /// A cancellation seen at the storage actor refuses the commit and leaves no addressable pending file.
    @Test func cancelledImageCannotCommitMediaAfterWaitingForStorage() async throws {
        let fixture = Fixture()
        defer { fixture.remove() }
        let meta = try await fixture.store.invoke(command: "create_project", args: ["name": .string("取消剧")])
        let id = try #require(meta["id"]?.string)
        do {
            _ = try await fixture.store.importMedia(id: id, bytes: Data([1]), mime: "image/png", source: "generated", extension: "png", isCancelled: { true })
            Issue.record("取消任务不能写入项目素材")
        } catch let failure as HostFailure {
            #expect(failure.code == "PW_CANCELLED")
        }
        let project = fixture.root.appendingPathComponent("projects/" + id)
        #expect(!FileManager.default.fileExists(atPath: project.path))
    }

    /// Cancellation arriving after bytes are synchronized still prevents rename and pending registration.
    @Test func cancellationAtAtomicCommitLeavesNoMediaFile() async throws {
        let fixture = Fixture()
        defer { fixture.remove() }
        let meta = try await fixture.store.invoke(command: "create_project", args: ["name": .string("提交取消剧")])
        let id = try #require(meta["id"]?.string)
        let checks = Mutex(0)
        do {
            _ = try await fixture.store.importMedia(id: id, bytes: Data([2, 3]), mime: "image/png", source: "generated", extension: "png", isCancelled: {
                checks.withLock { count in count += 1; return count >= 2 }
            })
            Issue.record("原子提交前取消仍落盘")
        } catch let failure as HostFailure { #expect(failure.code == "PW_CANCELLED") }
        let assets = fixture.root.appendingPathComponent("projects/" + id + "/assets")
        #expect(try FileManager.default.contentsOfDirectory(atPath: assets.path).isEmpty)
        #expect(checks.withLock { $0 } == 2)
    }

    /// One isolated root/actor belongs to each test and is never a live application-data directory.
    private struct Fixture {
        let root: URL
        let store: NativeProjectStore

        /// Captures one actor for the complete lifecycle, including session pending/alias state.
        init() {
            root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-native-media-" + UUID().uuidString)
            store = NativeProjectStore(root: root)
        }

        /// Only fixture-owned temporary data is eligible for cleanup.
        func remove() { try? FileManager.default.removeItem(at: root) }
    }
}
