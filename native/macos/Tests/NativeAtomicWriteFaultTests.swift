import Foundation
import Testing
@testable import PlotWeaveNative

/// System-call fault injection proves the §10.0 atomic-write failure classes for the Swift save path (#543):
/// pre-commit failures keep the old document, while a post-rename directory barrier failure reports honestly
/// with the new document already committed. Each fault window is bound to this fixture's own projects
/// directory descriptor, so concurrently running sibling suites with other temporary roots are never
/// intercepted regardless of the runner's concurrency mode; `.serialized` additionally orders these two tests.
@Suite(.serialized)
struct NativeAtomicWriteFaultTests {
    /// Pre-commit stages (temporary-file fsync, rename) surface the I/O diagnostic, keep the old document, leave no residue and converge on retry.
    @Test func preCommitStageFailuresKeepOldDocumentAndRetryConverges() async throws {
        let cases: [(stage: NativeAtomicWriteFaults.Stage, reached: [NativeAtomicWriteFaults.Stage], context: String)] = [
            (.temporaryFileSync, [.temporaryFileSync], "同步文件内容失败"),
            (.rename, [.temporaryFileSync, .rename], "提交原子写失败")
        ]
        for fault in cases {
            let fixture = try Fixture()
            defer { fixture.remove() }
            let id = try await fixture.createProject()
            _ = try await fixture.save(id: id, name: "改前")
            var injection: NativeAtomicWriteFaults.Injection? = NativeAtomicWriteFaults.Injection(failing: fault.stage, owner: try await fixture.projectsOwner())
            do {
                _ = try await fixture.save(id: id, name: "改后")
                Issue.record("阶段 \(fault.stage) 注入后保存未失败")
            } catch let failure as HostFailure {
                #expect(failure.code == "PW_STORAGE_ERROR")
                #expect(failure.message.hasPrefix(fault.context))
            }
            #expect(injection?.reached == fault.reached, "注入阶段未按协议顺序抵达：\(String(describing: injection?.reached))")
            injection = nil
            #expect(try fixture.projectName(id: id) == "改前", "提交前失败必须保留旧文档")
            #expect(try fixture.temporaryResidue().isEmpty, "失败保存不得遗留临时文件")
            #expect(try await fixture.save(id: id, name: "改后")["name"]?.string == "改后")
            #expect(try fixture.projectName(id: id) == "改后", "注入撤除后重试收敛为新文档")
            #expect(try fixture.temporaryResidue().isEmpty)
        }
    }

    /// A post-rename directory barrier failure reports the error honestly with the new document already committed; retry converges idempotently.
    @Test func directorySyncFailureReportsErrorWithNewDocumentCommitted() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let id = try await fixture.createProject()
        _ = try await fixture.save(id: id, name: "改前")
        var injection: NativeAtomicWriteFaults.Injection? = NativeAtomicWriteFaults.Injection(failing: .directorySync, owner: try await fixture.projectsOwner())
        do {
            _ = try await fixture.save(id: id, name: "改后")
            Issue.record("目录屏障注入后保存未失败")
        } catch let failure as HostFailure {
            #expect(failure.code == "PW_STORAGE_ERROR")
            #expect(failure.message.hasPrefix("同步目录条目失败"))
        }
        // rename 前置于屏障：三阶段按协议顺序抵达自证守卫，目录屏障失败时 rename 已成功提交
        #expect(injection?.reached == [.temporaryFileSync, .rename, .directorySync])
        injection = nil
        #expect(try fixture.projectName(id: id) == "改后", "提交后失败不保证回滚：新文档应已在磁盘")
        #expect(try fixture.temporaryResidue().isEmpty)
        #expect(try await fixture.save(id: id, name: "改后")["name"]?.string == "改后")
        #expect(try fixture.projectName(id: id) == "改后", "重试幂等收敛，文档保持新内容")
        #expect(try fixture.temporaryResidue().isEmpty)
    }

    /// Each test owns a disposable temporary root; no application-support or user data path is consulted.
    private struct Fixture {
        let root: URL
        let projects: URL
        let store: NativeProjectStore

        /// Prepares ordinary disk fixtures outside production command paths.
        init() throws {
            root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-native-faults-" + UUID().uuidString)
            projects = root.appendingPathComponent("projects")
            store = NativeProjectStore(root: root)
            try FileManager.default.createDirectory(at: projects, withIntermediateDirectories: true)
        }

        /// Removes the test-owned tree after awaited operations have settled.
        func remove() { try? FileManager.default.removeItem(at: root) }

        /// Creates the baseline project through the production command and returns its id.
        func createProject() async throws -> String {
            let created = try await store.invoke(command: "create_project", args: ["name": .string("故障注入剧")])
            return try #require(created["id"]?.string)
        }

        /// Anchors the fault window to this store's own projects directory so sibling-suite writers in other directories are never intercepted.
        func projectsOwner() async throws -> Int32 {
            try await store.projectsDirectory().descriptor
        }

        /// Saves a complete envelope with the given project name through the caller-visible command.
        func save(id: String, name: String) async throws -> HostJSON {
            try await store.invoke(command: "save_project", args: ["id": .string(id), "doc": Self.document(id: id, name: name)])
        }

        /// Reads the persisted document's project name straight from disk, bypassing load normalization.
        func projectName(id: String) throws -> String {
            let data = try Data(contentsOf: projects.appendingPathComponent(id + ".json"))
            let document = try JSONDecoder().decode(HostJSON.self, from: data)
            return try #require(document["project"]?["name"]?.string)
        }

        /// Leftover atomic-write temporary files are residue the failure path must not leave behind.
        func temporaryResidue() throws -> [String] {
            try FileManager.default.contentsOfDirectory(atPath: projects.path).filter { $0.hasSuffix(".tmp") }
        }

        /// Contract fixture uses complete authoritative v1 buckets without importing production builders.
        static func document(id: String, name: String) -> HostJSON {
            .object([
                "schemaVersion": .number(1), "project": .object([
                    "id": .string(id), "name": .string(name),
                    "createdAt": .string("2026-10-15T00:00:00.000Z"), "updatedAt": .string("2026-10-15T00:00:00.000Z")
                ]), "graph": .object(["nodes": .array([]), "edges": .array([])]),
                "settings": .object(["characters": .object([:]), "locations": .object([:]), "props": .object([:]), "documents": .object([:])]),
                "episodeTitles": .object([:]), "assets": .object(["byId": .object([:])])
            ])
        }
    }
}
