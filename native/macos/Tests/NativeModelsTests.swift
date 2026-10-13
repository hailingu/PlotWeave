import Foundation
import Synchronization
import Testing
@testable import PlotWeaveNative

/// Real settings/project actors and injected HTTP prove native model results across the persistence boundary.
struct NativeModelsTests {
    /// Chat preserves complete assistant tool-call payloads and sends only the existing OpenAI request shape.
    @Test func chatReadsOnlyConfiguredCipherAndReturnsUntouchedMessage() async throws {
        let fixture = Fixture()
        defer { fixture.remove() }
        try await fixture.configure()
        let message: HostJSON = .object(["role": .string("assistant"), "content": .null, "tool_calls": .array([.object(["id": .string("call"), "type": .string("function")])])])
        let seen = Mutex<[NativeProviderRequest]>([])
        let models = fixture.models(post: { request in
            seen.withLock { $0.append(request) }
            return try Self.reply(.object(["choices": .array([.object(["message": message])])]))
        })
        var args = Self.chatArgs
        args["tools"] = .array([.object(["type": .string("function")])])
        #expect(try await models.invoke(command: "llm_chat", args: args) == message)
        let request = try #require(seen.withLock { $0.first })
        #expect(request.url.absoluteString == "https://provider.example/v1/chat/completions")
        #expect(request.key == "fixture-key")
        #expect(request.body["stream"] == .bool(false))
        #expect(request.body["tool_choice"] == .string("auto"))
        #expect(request.maximum == 16 * 1024 * 1024)
    }

    /// Missing keys, malformed model inputs and unsafe remote HTTP never issue a billable request.
    @Test func preflightFailuresNeverReachHTTP() async throws {
        let fixture = Fixture()
        defer { fixture.remove() }
        let seen = Mutex(0)
        let models = fixture.models(post: { _ in seen.withLock { $0 += 1 }; return try Self.reply(.object([:])) })
        await #expect(throws: HostFailure.self) { try await models.invoke(command: "llm_chat", args: Self.chatArgs) }
        try await fixture.configure()
        for patch in [["model": HostJSON.string(" ")], ["baseUrl": .string("http://provider.example/v1")], ["providerId": .string("bad:id")]] {
            var args = Self.chatArgs
            args.merge(patch) { _, new in new }
            await #expect(throws: HostFailure.self) { try await models.invoke(command: "llm_chat", args: args) }
        }
        #expect(seen.withLock { $0 } == 0)
    }

    /// Base64 output is typed by magic bytes and immediately usable before any Web document save.
    @Test func imageRegistersExistingProjectAndBecomesAddressableBeforeSave() async throws {
        let fixture = Fixture()
        defer { fixture.remove() }
        try await fixture.configure()
        let id = try await fixture.createProject()
        let seen = Mutex<[NativeProviderRequest]>([])
        let models = fixture.models(post: { request in
            seen.withLock { $0.append(request) }
            return try Self.reply(.object(["data": .array([.object(["b64_json": .string(Self.png.base64EncodedString()), "url": .string("https://unused.example/image")])])]))
        })
        let asset = try await models.invoke(command: "llm_image_generate", args: Self.imageArgs(id))
        #expect(asset["source"] == .string("generated"))
        #expect(asset["mime"] == .string("image/png"))
        let assetId = try #require(asset["id"]?.string)
        #expect(try await fixture.projects.openMedia(id: id, assetId: assetId).read(maxBytes: 1024) == Self.png)
        #expect(try await fixture.projects.loadProject(id: id)["assets"]?["byId"]?.object == [:])
        let request = try #require(seen.withLock { $0.first })
        #expect(request.body["response_format"] == nil)
        #expect(request.body["prompt"] == .string("生成分镜"))
        #expect(request.url.path == "/v1/images/generations")
        #expect(request.maximum == 64 * 1024 * 1024)
    }

    /// Invalid base64 falls back to the validated URL downloader; unsupported output cannot enter project assets.
    @Test func urlFallbackAndInvalidOutputFollowSameStorageContract() async throws {
        let fixture = Fixture()
        defer { fixture.remove() }
        try await fixture.configure()
        let id = try await fixture.createProject()
        let seen = Mutex<[String]>([])
        let response = try Self.reply(.object(["data": .array([.object(["b64_json": .string("not base64"), "url": .string("https://images.example/image")])])]))
        let models = NativeModels(preferences: fixture.preferences, projects: fixture.projects, post: { _ in response }, download: { url, _, _ in seen.withLock { $0.append(url) }; return Self.png })
        #expect(try await models.invoke(command: "llm_image_generate", args: Self.imageArgs(id))["mime"] == .string("image/png"))
        #expect(seen.withLock { $0 } == ["https://images.example/image"])
        let invalid = fixture.models(post: { _ in try Self.reply(.object(["data": .array([.object(["b64_json": .string(Data("bad".utf8).base64EncodedString())])])])) })
        await #expect(throws: HostFailure.self) { try await invalid.invoke(command: "llm_image_generate", args: Self.imageArgs(id)) }
    }

    /// Both pre-cancel and cancellation during a provider response prevent a late media commit.
    @Test func cancelledJobNeverCommitsAndCanRetryWithNewIdentity() async throws {
        let fixture = Fixture()
        defer { fixture.remove() }
        try await fixture.configure()
        let id = try await fixture.createProject()
        let started = Mutex(false)
        let models = fixture.models(post: { _ in
            started.withLock { $0 = true }
            try await Task.sleep(for: .milliseconds(30))
            return try Self.reply(.object(["data": .array([.object(["b64_json": .string(Self.png.base64EncodedString())])])]))
        })
        #expect(try await models.invoke(command: "llm_image_cancel", args: ["jobId": .string("job")]) == .null)
        await #expect(throws: HostFailure.self) { try await models.invoke(command: "llm_image_generate", args: Self.imageArgs(id)) }
        #expect(!started.withLock { $0 })
        let generation = Task { try await models.invoke(command: "llm_image_generate", args: Self.imageArgs(id)) }
        for _ in 0..<5000 {
            if started.withLock({ $0 }) { break }
            try await Task.sleep(for: .milliseconds(1))
        }
        try #require(started.withLock { $0 })
        _ = try await models.invoke(command: "llm_image_cancel", args: ["jobId": .string("job")])
        await #expect(throws: HostFailure.self) { try await generation.value }
        #expect(!FileManager.default.fileExists(atPath: fixture.root.appendingPathComponent("projects/" + id).path))
        #expect(try await models.invoke(command: "llm_image_generate", args: Self.imageArgs(id, job: "fresh"))["id"]?.string != nil)
    }

    /// A project deleted while HTTP is pending cannot be recreated by its completed model result.
    @Test func deletedProjectRejectsLateImageResult() async throws {
        let fixture = Fixture()
        defer { fixture.remove() }
        try await fixture.configure()
        let id = try await fixture.createProject()
        let started = Mutex(false)
        let models = fixture.models(post: { _ in started.withLock { $0 = true }; try await Task.sleep(for: .milliseconds(30)); return try Self.reply(.object(["data": .array([.object(["b64_json": .string(Self.png.base64EncodedString())])])])) })
        let generation = Task { try await models.invoke(command: "llm_image_generate", args: Self.imageArgs(id)) }
        for _ in 0..<5000 {
            if started.withLock({ $0 }) { break }
            try await Task.sleep(for: .milliseconds(1))
        }
        try #require(started.withLock { $0 })
        _ = try await fixture.projects.invoke(command: "delete_project", args: ["id": .string(id)])
        await #expect(throws: HostFailure.self) { try await generation.value }
        #expect(!FileManager.default.fileExists(atPath: fixture.root.appendingPathComponent("projects/" + id).path))
    }

    /// Provider error diagnostics cannot echo bearer or signed-URL secrets, and invalid JSON is never a reply.
    @Test func providerFailureRedactsSecretsAndRejectsInvalidChatShapes() async throws {
        let fixture = Fixture()
        defer { fixture.remove() }
        try await fixture.configure()
        let models = fixture.models(post: { request in
            NativeHTTPReply(status: 503, headers: [:], body: Data((request.key + " " + request.url.absoluteString + " " + (request.url.user ?? "") + " " + (request.url.password ?? "")).utf8))
        })
        var args = Self.chatArgs
        args["baseUrl"] = .string("https://fixture-user:fixture-password@provider.example/v1?token=query-secret#fragment-secret")
        do { _ = try await models.invoke(command: "llm_chat", args: args); Issue.record("服务错误不能成功") }
        catch let failure as HostFailure {
            #expect(failure.code == "PW_MODEL_STATUS")
            for secret in ["fixture-key", "fixture-user", "fixture-password", "query-secret", "fragment-secret"] { #expect(!failure.message.contains(secret)) }
            #expect(failure.message.contains("503"))
        }
        for bytes in [Data("{bad".utf8), Data("{\"choices\":[{\"message\":\"wrong\"}]}".utf8)] {
            let invalid = fixture.models(post: { _ in NativeHTTPReply(status: 200, headers: [:], body: bytes) })
            await #expect(throws: HostFailure.self) { try await invalid.invoke(command: "llm_chat", args: Self.chatArgs) }
        }
    }

    /// Tombstones stay bounded and consumed once; a completed/error job releases its active identity.
    @Test func cancelledTombstonesAreBoundedAndDoNotDisableFreshWorkForever() async throws {
        let fixture = Fixture()
        defer { fixture.remove() }
        try await fixture.configure()
        let id = try await fixture.createProject()
        let calls = Mutex(0)
        let models = fixture.models(post: { _ in calls.withLock { $0 += 1 }; return try Self.reply(.object(["data": .array([.object(["b64_json": .string(Self.png.base64EncodedString())])])])) })
        _ = try await models.invoke(command: "llm_image_cancel", args: ["jobId": .string("evicted")])
        for index in 0..<64 { _ = try await models.invoke(command: "llm_image_cancel", args: ["jobId": .string("cancel-" + String(index))]) }
        #expect(try await models.invoke(command: "llm_image_generate", args: Self.imageArgs(id, job: "evicted"))["id"]?.string != nil)
        await #expect(throws: HostFailure.self) { try await models.invoke(command: "llm_image_generate", args: Self.imageArgs(id, job: "cancel-63")) }
        #expect(calls.withLock { $0 } == 1)
        #expect(try await models.invoke(command: "llm_image_generate", args: Self.imageArgs(id, job: "cancel-63"))["id"]?.string != nil)
        #expect(calls.withLock { $0 } == 2)
    }

    /// Host/session task cancellation releases provider work and cannot leave a pending generated file.
    @Test func cancelledCallerCannotPersistItsImage() async throws {
        let fixture = Fixture()
        defer { fixture.remove() }
        try await fixture.configure()
        let id = try await fixture.createProject()
        let started = Mutex(false)
        let models = fixture.models(post: { _ in
            started.withLock { $0 = true }
            try await Task.sleep(for: .seconds(10))
            return try Self.reply(.object(["data": .array([.object(["b64_json": .string(Self.png.base64EncodedString())])])]))
        })
        let generation = Task { try await models.invoke(command: "llm_image_generate", args: Self.imageArgs(id)) }
        for _ in 0..<5000 { if started.withLock({ $0 }) { break }; try await Task.sleep(for: .milliseconds(1)) }
        try #require(started.withLock { $0 })
        generation.cancel()
        await #expect(throws: CancellationError.self) { try await generation.value }
        #expect(!FileManager.default.fileExists(atPath: fixture.root.appendingPathComponent("projects/" + id).path))
    }

    /// Invariant request fixtures describe the unchanged camelCase IPC shape, not source-text structure.
    private static let chatArgs: [String: HostJSON] = ["providerId": .string("openai"), "baseUrl": .string("https://provider.example/v1"), "model": .string("fixture-model"), "messages": .array([.object(["role": .string("user"), "content": .string("测试")])])]
    /// A magic-byte PNG fixture suffices because the existing image contract validates signatures, not decoding.
    private static let png = Data([0x89, 0x50, 0x4e, 0x47])
    /// Every generated request carries an explicit immutable project and job identity.
    private static func imageArgs(_ id: String, job: String = "job") -> [String: HostJSON] {
        ["request": .object(["projectId": .string(id), "jobId": .string(job), "providerId": .string("openai"), "baseUrl": .string("https://provider.example/v1"), "model": .string("image-model"), "prompt": .string("  生成分镜  "), "size": .string("1024x1024")])]
    }
    /// External response fixtures are encoded as actual JSON bytes before the production parser receives them.
    private static func reply(_ value: HostJSON) throws -> NativeHTTPReply { NativeHTTPReply(status: 200, headers: [:], body: try JSONEncoder().encode(value)) }

    /// Fixture actors own one disposable native root, independent of the running app identity.
    private struct Fixture {
        /// Shared actors make media visibility and key lookup assertions cross real storage boundaries.
        let root: URL
        let preferences: NativePreferences
        let projects: NativeProjectStore
        /// Service construction stays lazy, with machine material supplied solely by this fixture.
        init() {
            root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-native-models-" + UUID().uuidString)
            preferences = NativePreferences(root: root, machineMaterial: { "fixture-machine" })
            projects = NativeProjectStore(root: root)
        }
        /// The same frontend set-key then full-save sequence configures this synthetic provider.
        func configure() async throws {
            let encrypted = try await preferences.invoke(command: "set_provider_key", args: ["providerId": .string("openai"), "key": .string("fixture-key")])
            _ = try await preferences.invoke(command: "save_prefs", args: ["prefs": .object(["providers": .array([.object(["id": .string("openai"), "keyEnc": encrypted])])])])
        }
        /// A real create command ensures generation addresses an existing project rather than a loose directory.
        func createProject() async throws -> String { try #require(try await projects.invoke(command: "create_project", args: ["name": .string("模型剧")])["id"]?.string) }
        /// Only external network is replaced; all business decoding and persistence remain production behavior.
        func models(post: @escaping NativeModels.Post) -> NativeModels {
            NativeModels(preferences: preferences, projects: projects, post: post, download: { _, _, _ in throw HostFailure(code: "PW_TEST_UNEXPECTED_DOWNLOAD", message: "unexpected URL fallback") })
        }
        /// No work survives its awaited test; cleanup touches only the freshly generated root.
        func remove() { try? FileManager.default.removeItem(at: root) }
    }
}
