import Foundation
import Testing
@testable import PlotWeaveNative

/// Both storage stacks consume raw numeric spelling from one shared schema-version corpus (#918).
struct NativeSchemaVersionVectorTests {
    /// Numeric values decide versions; rejected claims never fall through to versionless shape repair.
    @Test func sharedRawNumberVectors() throws {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("crates/plotweave-core/testdata/schema-version-contract.json")
        let vectors = try HostJSON.decode(Data(contentsOf: file))
        #expect(vectors["version"] == .number(1))
        let cases = try #require(vectors["cases"]?.arrayValue)
        #expect(!cases.isEmpty)
        for row in cases {
            let raw = try #require(row["raw"]?.string)
            do {
                let value = try NativeProjectEnvelope.parse(HostJSON.decode(document(raw)), id: "p1")
                #expect(row["accepted"] == .bool(true), "\(row["id"] ?? .null)")
                #expect(value["schemaVersion"] == row["version"], "\(row["id"] ?? .null)")
                #expect((value["versionless"] ?? .bool(false)) == row["versionless"], "\(row["id"] ?? .null)")
            } catch { #expect(row["accepted"] == .bool(false), "\(row["id"] ?? .null)") }
        }
    }

    /// Real file load and home metadata classification preserve the original bytes for accepted and rejected inputs.
    @Test func numericSpellingSurvivesLoadAndListWithoutRewriting() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-schema-number-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let projects = root.appendingPathComponent("projects")
        try FileManager.default.createDirectory(at: projects, withIntermediateDirectories: true)
        let file = projects.appendingPathComponent("p1.json")
        let store = NativeProjectStore(root: root)
        for (raw, accepted, version) in [("1.0", true, 1.0), ("1e2", true, 100.0), ("1.5", false, 0.0), ("-1.0", false, 0.0)] {
            let bytes = document(raw)
            try bytes.write(to: file)
            do {
                let value = try await store.invoke(command: "load_project", args: ["id": .string("p1")])
                #expect(accepted)
                #expect(value["schemaVersion"] == .number(version))
            } catch { #expect(!accepted) }
            let rows = try #require(try await store.invoke(command: "list_projects", args: [:]).arrayValue)
            #expect(rows.count == 1)
            #expect((rows.first?["diagnostic"] == nil) == accepted)
            #expect(try Data(contentsOf: file) == bytes)
        }
    }

    /// Raw syntax is retained until the actual HostJSON boundary parses it.
    private func document(_ raw: String) -> Data {
        Data(("{\"schemaVersion\":" + raw + ",\"project\":{\"id\":\"p1\",\"name\":\"vector\"},\"graph\":{\"nodes\":[],\"edges\":[]},\"assets\":{\"byId\":{}}}").utf8)
    }
}
