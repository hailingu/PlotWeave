import Foundation
import Testing
@testable import PlotWeaveNative

/// A failed document read must preserve all session authority until project absence is confirmed (#905).
struct NativeProjectMediaReadFailureTests {
    /// Injection targets the document read only; retries exercise the real control file and media descriptors.
    @Test(arguments: ["PW_STORAGE_ERROR", "PW_STORAGE_LIMIT", "PW_PROJECT_CORRUPT"])
    func readFailurePreservesSession(code: String) async throws {
        let fixture = try await Fixture()
        defer { fixture.remove() }
        do {
            _ = try await fixture.store.openMedia(id: fixture.id, assetId: fixture.assetID, loadDocument: { _ in
                throw HostFailure(code: code, message: "injected document read")
            })
            Issue.record("read failure must propagate")
        } catch let failure as HostFailure {
            #expect(failure.code == code)
            #expect(failure.message == "injected document read")
        }
        try await fixture.assertPreserved()
    }

    /// Actual corrupt bytes traverse loadProject's decoder, then restored bytes permit pending and alias delivery.
    @Test func corruptControlFileCanRecoverWithoutSave() async throws {
        let fixture = try await Fixture()
        defer { fixture.remove() }
        let before = try Data(contentsOf: fixture.control)
        try Data("{".utf8).write(to: fixture.control)
        do {
            _ = try await fixture.store.openMedia(id: fixture.id, assetId: fixture.assetID)
            Issue.record("corrupt document must fail")
        } catch let failure as HostFailure { #expect(failure.code == "PW_PROJECT_CORRUPT") }
        try before.write(to: fixture.control)
        try await fixture.assertPreserved()
    }

    /// Absence retires pending refs, identity aliases and file-owning receipts together.
    @Test func missingProjectRetiresAllSessionAuthority() async throws {
        let fixture = try await Fixture()
        defer { fixture.remove() }
        try FileManager.default.removeItem(at: fixture.control)
        do {
            _ = try await fixture.store.openMedia(id: fixture.id, assetId: fixture.assetID)
            Issue.record("missing project must fail")
        } catch let failure as HostFailure { #expect(failure.code == "project_not_found") }
        #expect(await fixture.store.pendingMedia[fixture.id] == nil)
        #expect(await fixture.store.mediaAliases[fixture.id] == nil)
        #expect(await fixture.store.importReceipts[fixture.id] == nil)
    }

    /// Real temporary project and discardable media keep state/bytes assertions independent of user data.
    private struct Fixture {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-project-read-" + UUID().uuidString)
        let store: NativeProjectStore
        let id: String
        let asset: HostJSON
        let assetID: String
        let alias = "repaired-identity"
        let bytes = Data([4, 8, 15, 16])
        var control: URL { root.appendingPathComponent("projects/" + id + ".json") }

        /// Writing the blank-key document directly models the unsaved repair window without consuming the receipt.
        init() async throws {
            store = NativeProjectStore(root: root)
            let meta = try await store.invoke(command: "create_project", args: ["name": .string("read failure")])
            id = try #require(meta["id"]?.string)
            asset = try await store.importMedia(id: id, bytes: bytes, mime: "image/png", source: "upload", extension: "png", discardable: true)
            assetID = try #require(asset["id"]?.string)
            var doc = try #require(try await store.loadProject(id: id).object)
            doc["assets"] = .object(["byId": .object([" ": asset])])
            try JSONEncoder().encode(HostJSON.object(doc)).write(to: control)
            try await store.registerAlias(id: id, blankKey: " ", freshId: alias)
        }

        /// State remains unchanged and real media delivery succeeds before any save can recreate pending refs.
        func assertPreserved() async throws {
            #expect(await store.pendingMedia[id]?[assetID] == asset)
            #expect(await store.mediaAliases[id]?[alias] == " ")
            #expect(await store.importReceipts[id]?[assetID] != nil)
            #expect(try await store.openMedia(id: id, assetId: assetID).read(maxBytes: 1024) == bytes)
            #expect(try await store.openMedia(id: id, assetId: alias).read(maxBytes: 1024) == bytes)
        }

        /// Only fixture-owned files are removed.
        func remove() { try? FileManager.default.removeItem(at: root) }
    }
}
