import Darwin
import Foundation
import Testing
@testable import PlotWeaveNative

/// Load verification may quarantine only proven missing or unsafe files, never transient I/O (#915).
struct NativeProjectAssetVerificationTests {
    /// A later transient failure suppresses earlier quarantine keys; the actual actor still owns directory I/O.
    @Test(arguments: [EMFILE, EIO, EACCES])
    func transientFailureCannotDeliverPartialKeys(reason: Int32) async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-project-verify-fault-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root.appendingPathComponent("projects/p1"), withIntermediateDirectories: true)
        let store = NativeProjectStore(root: root)
        let assets = HostJSON.object(["byId": .object([
            "a-missing": .object(["relPath": .string("assets/missing.png")]),
            "z-transient": .object(["relPath": .string("assets/valid.png")])
        ])])
        do {
            _ = try await store.verifyAssets(id: "p1", assets: assets, validateMedia: { _, path, _ in
                if path.hasSuffix("missing.png") { throw NativeDirectory.refused("confirmed missing") }
                errno = reason
                throw NativeDirectory.ioError("injected media verification")
            })
            Issue.record("A transient failure must suppress the earlier missing key")
        } catch let failure as HostFailure { #expect(failure.code == "PW_STORAGE_ERROR") }
        await store.close()
        do {
            _ = try await store.invoke(command: "verify_project_assets", args: ["id": .string("p1"), "assets": assets])
            Issue.record("A closed store cannot report all media as missing")
        } catch let failure as HostFailure { #expect(failure.code == "PW_CORE_CLOSED") }
    }

    /// A real permission failure rejects verification and retains complete metadata through a later save/reopen.
    @Test func permissionDeniedRetainsAssetAndRecovers() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-project-verify-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = NativeProjectStore(root: root)
        let created = try await store.invoke(command: "create_project", args: ["name": .string("保留媒体")])
        let id = try #require(created["id"]?.string)
        let asset = try await store.importMedia(id: id, bytes: Data([7, 8]), mime: "image/png", source: "upload", extension: "png")
        let assetID = try #require(asset["id"]?.string)
        let assets = HostJSON.object(["byId": .object([assetID: asset])])
        var document = try #require(try await store.invoke(command: "load_project", args: ["id": .string(id)]).object)
        document["assets"] = assets
        _ = try await store.invoke(command: "save_project", args: ["id": .string(id), "doc": .object(document)])
        let file = root.appendingPathComponent("projects/" + id + "/" + (try #require(asset["relPath"]?.string)))
        let control = root.appendingPathComponent("projects/" + id + ".json")
        let before = try Data(contentsOf: control)
        #expect(chmod(file.path, 0) == 0)
        defer { chmod(file.path, mode_t(S_IRUSR | S_IWUSR)) }
        do {
            _ = try await store.invoke(command: "verify_project_assets", args: ["id": .string(id), "assets": assets])
            Issue.record("A transient read failure must not deliver quarantine keys")
        } catch let failure as HostFailure { #expect(failure.code == "PW_STORAGE_ERROR") }
        #expect(try Data(contentsOf: control) == before)
        #expect(chmod(file.path, mode_t(S_IRUSR | S_IWUSR)) == 0)
        #expect(try await store.invoke(command: "verify_project_assets", args: ["id": .string(id), "assets": assets]) == .array([]))
        _ = try await store.invoke(command: "save_project", args: ["id": .string(id), "doc": .object(document)])
        let loaded = try await NativeProjectStore(root: root).invoke(command: "load_project", args: ["id": .string(id)])
        #expect(loaded["assets"] == assets)
        #expect(try Data(contentsOf: file) == Data([7, 8]))
    }
}
