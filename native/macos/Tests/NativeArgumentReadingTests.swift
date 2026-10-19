import Foundation
import Testing
@testable import PlotWeaveNative

/// Consumer characterization protects domain errors and empty-string policy during shared-reader extraction.
@MainActor
struct NativeArgumentReadingTests {
    /// Missing and non-string inputs fail at the original domain boundary before I/O or provider work.
    @Test func malformedStringsPreserveDomainFailures() async throws {
        let fixture = Fixture()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let invalid: [HostJSON?] = [nil, .null, .number(1), .bool(false), .array([]), .object([:])]
        for value in invalid {
            var args: [String: HostJSON] = [:]
            args["id"] = value
            try await expectFailure(code: "PW_INVALID_REQUEST", message: "缺少 id 字段") {
                try await fixture.projects.invoke(command: "load_project", args: args)
            }
            try await expectFailure(code: "PW_LIBRARY_INVALID", message: "缺少必填字段") {
                try await fixture.library.invoke("delete_library_asset", args: args)
            }
            args["asset"] = .object([:])
            try await expectFailure(code: "PW_LIBRARY_INVALID", message: "素材请求缺少必填字段") {
                try await fixture.assets.invoke("validate_project_asset", args: args)
            }
            var modelArgs: [String: HostJSON] = [:]
            modelArgs["jobId"] = value
            try await expectFailure(code: "PW_MODEL_ERROR", message: "模型请求字符串参数缺失或类型错误") {
                try await fixture.models.invoke(command: "llm_image_cancel", args: modelArgs)
            }
        }
        #expect(!FileManager.default.fileExists(atPath: fixture.root.path))
    }

    /// Only project strings reject empty here; other domains preserve downstream validation or valid cancellation.
    @Test func emptyStringsPreserveDomainPolicy() async throws {
        let fixture = Fixture()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        try await expectFailure(code: "PW_INVALID_REQUEST", message: "缺少 id 字段") {
            try await fixture.projects.invoke(command: "load_project", args: ["id": .string("")])
        }
        try await expectFailure(code: "PW_LIBRARY_INVALID", message: "素材身份无效") {
            try await fixture.library.invoke("delete_library_asset", args: ["id": .string("")])
        }
        try await expectFailure(code: "PW_INVALID_REQUEST", message: "资产 id、路径、来源或 UTC 时间无效") {
            try await fixture.assets.invoke("validate_project_asset", args: ["id": .string(""), "asset": .object([:])])
        }
        let result = try await fixture.models.invoke(command: "llm_image_cancel", args: ["jobId": .string("")])
        #expect(result == .object(["cancelled": .bool(false)]))
        #expect(!FileManager.default.fileExists(atPath: fixture.root.path))
    }

    /// Successful reads preserve all Unicode and whitespace; the reader has no normalization side effects.
    @Test func sharedReaderPreservesExactStringValue() throws {
        let value = "  值🧵\n\t "
        for domain in [HostArgumentDomain.project, .library, .asset, .model] {
            #expect(try ["field": HostJSON.string(value)].requiredString("field", domain: domain) == value)
        }
    }

    /// Unexpected success or an unstructured failure cannot satisfy an error contract assertion.
    private func expectFailure(code: String, message: String, operation: @MainActor () async throws -> HostJSON) async throws {
        do { _ = try await operation() }
        catch let failure as HostFailure {
            #expect(failure.code == code)
            #expect(failure.message == message)
            return
        }
        catch { throw error }
        Issue.record("Expected a structured argument failure")
        throw CocoaError(.coderInvalidValue)
    }

    /// Real actors share an absent, disposable root; argument validation must never create it.
    private struct Fixture {
        let root: URL
        let projects: NativeProjectStore
        let library: NativeLibrary
        let assets: NativeAssets
        let models: NativeModels

        /// Construction has no I/O and never reads user credentials.
        init() {
            root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-argument-reader-" + UUID().uuidString)
            projects = NativeProjectStore(root: root)
            library = NativeLibrary(root: root)
            assets = NativeAssets(library: library, projects: projects)
            let preferences = NativePreferences(root: root, machineMaterial: { "argument-fixture-material" })
            models = NativeModels(preferences: preferences, projects: projects)
        }
    }
}
