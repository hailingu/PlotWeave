import Foundation
import Testing
@testable import PlotWeaveNative

/// Real temporary roots prove the Swift storage implementation preserves project and AI contracts.
struct NativeProjectStoreTests {
    /// Create/save/reopen keeps all graph/settings payloads and derives the home summary from graph.
    @Test func documentRoundtripPreservesCompletePayload() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let created = try await fixture.store.invoke(command: "create_project", args: ["name": .string("  原生剧  ")])
        let id = try #require(created["id"]?.string)
        var doc = try #require(try await fixture.store.invoke(command: "load_project", args: ["id": .string(id)]).object)
        var project = try #require(doc["project"]?.object)
        project["name"] = .string("编辑后的剧")
        doc["project"] = .object(project)
        doc["graph"] = .object([
            "nodes": .array([.object(["id": .string("scene-1"), "type": .string("scene"), "data": .object(["script": .string("完整正文")])])]),
            "edges": .array([]), "viewport": .object(["x": .number(22), "y": .number(3), "zoom": .number(1.25)])
        ])
        let saved = try await fixture.store.invoke(command: "save_project", args: ["id": .string(id), "doc": .object(doc), "expectExisting": .bool(true)])
        #expect(saved["name"]?.string == "编辑后的剧")
        #expect(saved["scene_count"] == .number(1))
        #expect(saved["ending_count"] == .number(1))
        let reopened = NativeProjectStore(root: fixture.root)
        let loaded = try await reopened.invoke(command: "load_project", args: ["id": .string(id)])
        #expect(loaded["graph"] == doc["graph"])
        #expect(loaded["settings"] == doc["settings"])
        #expect(loaded["project"]?["name"]?.string == "编辑后的剧")
    }

    /// Actor-serialized deletion blocks guarded late document and AI saves without resurrecting any path.
    @Test func deletionRefusesLateSaveAndAiWithoutResurrection() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let created = try await fixture.store.invoke(command: "create_project", args: ["name": .string("即将删除")])
        let id = try #require(created["id"]?.string)
        let doc = try await fixture.store.invoke(command: "load_project", args: ["id": .string(id)])
        _ = try await fixture.store.invoke(command: "delete_project", args: ["id": .string(id)])
        await #expect(throws: HostFailure.self) {
            try await fixture.store.invoke(command: "save_project", args: ["id": .string(id), "doc": doc, "expectExisting": .bool(true)])
        }
        await #expect(throws: HostFailure.self) {
            try await fixture.store.invoke(command: "save_ai_session", args: ["id": .string(id), "session": Self.session])
        }
        #expect(!FileManager.default.fileExists(atPath: fixture.projects.appendingPathComponent(id + ".json").path))
        #expect(!FileManager.default.fileExists(atPath: fixture.projects.appendingPathComponent(id).path))
        do { _ = try await fixture.store.invoke(command: "load_project", args: ["id": .string(id)]) }
        catch let failure as HostFailure { #expect(failure.message.hasPrefix("[project_not_found]")) }
    }

    /// A corrupt file remains discoverable as its own diagnostic card without clearing valid projects.
    @Test func malformedProjectIsAnIsolatedDiagnosticCard() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        try fixture.write("good.json", Self.document("good", name: "正常"))
        try Data("{broken".utf8).write(to: fixture.projects.appendingPathComponent("broken.json"))
        let listed = try await fixture.store.invoke(command: "list_projects", args: [:])
        let rows = try #require(listed.arrayValue)
        #expect(rows.count == 2)
        #expect(rows.first { $0["id"]?.string == "good" }?["name"]?.string == "正常")
        #expect(rows.first { $0["id"]?.string == "broken" }?["diagnostic"]?.string != nil)
    }

    /// A missing AI file is empty history; invalid AI JSON is reported and never written by a read.
    @Test func aiSessionCorruptionDoesNotFallBackToEmptyWrite() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        try fixture.write("p-ai.json", Self.document("p-ai"))
        let absent = try await fixture.store.invoke(command: "load_ai_session", args: ["id": .string("p-ai")])
        #expect(absent == .object(["session": .null, "corrupt": .bool(false)]))
        _ = try await fixture.store.invoke(command: "save_ai_session", args: ["id": .string("p-ai"), "session": Self.session])
        let file = fixture.projects.appendingPathComponent("p-ai/ai-session.json")
        #expect(try await fixture.store.invoke(command: "load_ai_session", args: ["id": .string("p-ai")])["session"] == Self.session)
        let damaged = Data("not-json".utf8)
        try damaged.write(to: file)
        let corrupt = try await fixture.store.invoke(command: "load_ai_session", args: ["id": .string("p-ai")])
        #expect(corrupt == .object(["session": .null, "corrupt": .bool(true)]))
        #expect(try Data(contentsOf: file) == damaged)
    }

    /// Asset verification and copying keep real bytes within an independent, still-existing destination project.
    @Test func assetCopyAndVerificationFollowProjectIdentity() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        try fixture.write("source.json", Self.document("source"))
        try fixture.write("destination.json", Self.document("destination"))
        let source = fixture.projects.appendingPathComponent("source/assets")
        try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
        let bytes = Data([0x89, 0x50, 0x4e, 0x47])
        try bytes.write(to: source.appendingPathComponent("image.png"))
        let assets: HostJSON = .object(["byId": .object([
            "ok": .object(["relPath": .string("assets/image.png")]),
            "missing": .object(["relPath": .string("assets/missing.png")])
        ])])
        #expect(try await fixture.store.invoke(command: "verify_project_assets", args: ["id": .string("source"), "assets": assets]) == .array([.string("missing")]))
        #expect(try await fixture.store.invoke(command: "copy_project_assets", args: ["fromId": .string("source"), "toId": .string("destination")]) == .null)
        #expect(try Data(contentsOf: fixture.projects.appendingPathComponent("destination/assets/image.png")) == bytes)
        await #expect(throws: HostFailure.self) {
            try await fixture.store.invoke(command: "copy_project_assets", args: ["fromId": .string("source"), "toId": .string("destination")])
        }
    }

    /// Save rejects a missing bucket as a whole instead of turning absent data into empty settings.
    @Test func malformedSaveCannotOverwriteExistingProject() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let original = Self.document("safe")
        try fixture.write("safe.json", original)
        var damaged = try #require(original.object)
        damaged.removeValue(forKey: "settings")
        await #expect(throws: HostFailure.self) {
            try await fixture.store.invoke(command: "save_project", args: ["id": .string("safe"), "doc": .object(damaged)])
        }
        #expect(try await fixture.store.invoke(command: "load_project", args: ["id": .string("safe")]) == original)
    }

    /// Contract fixture uses complete authoritative v1 buckets without importing production builders.
    private static func document(_ id: String, name: String = "测试剧") -> HostJSON {
        .object([
            "schemaVersion": .number(1), "project": .object([
                "id": .string(id), "name": .string(name), "createdAt": .string("2026-10-04T00:00:00.000Z"), "updatedAt": .string("2026-10-04T00:00:00.000Z")
            ]), "graph": .object(["nodes": .array([]), "edges": .array([])]),
            "settings": .object(["characters": .object([:]), "locations": .object([:]), "props": .object([:]), "documents": .object([:])]),
            "episodeTitles": .object([:]), "assets": .object(["byId": .object([:])])
        ])
    }

    /// AI wire schema is independently defined by version and entries, with application data preserved.
    private static let session: HostJSON = .object(["schemaVersion": .number(1), "entries": .array([.object(["id": .string("entry-1"), "text": .string("保留聊天")])])])

    /// Each test owns a disposable directory and a new I/O actor; no application-support root is consulted.
    private struct Fixture {
        let root: URL
        let projects: URL
        let store: NativeProjectStore

        /// Prepares ordinary disk fixtures outside production command paths.
        init() throws {
            root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-native-store-" + UUID().uuidString)
            projects = root.appendingPathComponent("projects")
            store = NativeProjectStore(root: root)
            try FileManager.default.createDirectory(at: projects, withIntermediateDirectories: true)
        }

        /// Creates only the JSON wire fixture selected by its caller.
        func write(_ name: String, _ value: HostJSON) throws {
            try JSONEncoder().encode(value).write(to: projects.appendingPathComponent(name))
        }

        /// Removes the test-owned tree after awaited operations have settled.
        func remove() { try? FileManager.default.removeItem(at: root) }
    }
}
