import CryptoKit
import Foundation
import Testing
@testable import PlotWeaveNative

/// External control files share the project decoder's bounded nesting contract (issue #916).
struct NativeControlFileDepthTests {
    /// Even syntactically valid deep objects are damaged; a partial library view never authorizes cleanup.
    @Test(arguments: [33, 400])
    func libraryRejectsDeepControlFile(depth: Int) async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-control-depth-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let directory = root.appendingPathComponent("library")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let bytes = nested(depth)
        let file = directory.appendingPathComponent("library.json")
        try bytes.write(to: file)
        #expect(NativeLibrarySalvage.parse(bytes).1)
        let view = try await NativeLibrary(root: root).invoke(command: "list_library_assets", args: [:])
        #expect(view["warnings"]?.array.isEmpty == false)
        #expect(try Data(contentsOf: file) == bytes)
    }

    /// Both preference readers reject damage and explicit replacement preserves the exact original bytes.
    @Test(arguments: [33, 400])
    func preferencesRejectAndBackUpDeepControlFile(depth: Int) async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-prefs-depth-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let bytes = nested(depth)
        let file = root.appendingPathComponent("settings.json")
        try bytes.write(to: file)
        let prefs = NativePreferences(root: root, machineMaterial: { "depth-test-machine" })
        do {
            _ = try await prefs.invoke(command: "load_prefs", args: [:])
            Issue.record("Over-depth settings must reject")
        } catch let failure as HostFailure { #expect(failure.code == "PW_PREFS_CORRUPT") }
        do {
            _ = try await prefs.providerCredential("openai", baseURL: "https://provider.example/v1", suffix: "")
            Issue.record("Credential reads must reject the same damaged file")
        } catch let failure as HostFailure { #expect(failure.code == "PW_PREFS_CORRUPT") }
        #expect(try Data(contentsOf: file) == bytes)
        _ = try await prefs.invoke(command: "save_prefs", args: ["prefs": .object([:])])
        let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        #expect(try Data(contentsOf: root.appendingPathComponent("settings-corrupt-" + digest + ".bak")) == bytes)
        #expect(try await prefs.invoke(command: "load_prefs", args: [:]) == .object([:]))
    }

    /// The accepted depth boundary retains Codable's exact values for both external file readers.
    @Test func depth32RemainsHealthyAndOpaque() async throws {
        let bytes = nested(32)
        let expected = try JSONDecoder().decode(HostJSON.self, from: bytes)
        let (value, damaged) = NativeLibrarySalvage.parse(bytes)
        #expect(!damaged)
        #expect(value == expected)
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-depth-boundary-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let file = root.appendingPathComponent("settings.json")
        try bytes.write(to: file)
        let prefs = NativePreferences(root: root)
        #expect(try await prefs.invoke(command: "load_prefs", args: [:]) == expected)
        _ = try await prefs.invoke(command: "save_prefs", args: ["prefs": .object([:])])
        #expect(try FileManager.default.contentsOfDirectory(atPath: root.path) == ["settings.json"])
    }

    /// Corrupt-root salvage bounds whole buckets, legacy array members and Record members independently.
    @Test(arguments: [33, 400])
    func salvageFragmentsRejectDepthWithoutDroppingHealthySiblings(depth: Int) throws {
        let deep = String(decoding: nested(depth), as: UTF8.self)
        let group = "\"groups\":{\"byId\":{\"g\":{\"keep\":true}}}"
        let rawBucket = Data(("{\"assets\":" + deep + "," + group + ",").utf8)
        let (bucket, bucketDamaged) = NativeLibrarySalvage.parse(rawBucket)
        #expect(bucketDamaged)
        #expect(bucket["groups"]?["byId"]?["g"]?["keep"] == .bool(true))
        #expect(bucket["assets"]?["byId"]?.object?.isEmpty == true)
        let array = Data(("{\"assets\":[" + deep + ",{\"keep\":true}],").utf8)
        let (legacy, legacyDamaged) = NativeLibrarySalvage.parse(array)
        #expect(legacyDamaged)
        #expect(legacy["assets"] == .array([.object(["keep": .bool(true)])]))
        let record = Data(("{\"assets\":{\"byId\":{\"deep\":" + deep + ",\"ok\":{\"keep\":true}}},").utf8)
        let (members, membersDamaged) = NativeLibrarySalvage.parse(record)
        #expect(membersDamaged)
        #expect(members["assets"]?["byId"]?["deep"] == nil)
        #expect(members["assets"]?["byId"]?["ok"]?["keep"] == .bool(true))
    }

    /// Construction stays iterative so the fixture cannot itself overflow a cooperative stack.
    private func nested(_ depth: Int) -> Data {
        Data((String(repeating: "{\"a\":", count: depth) + "0" + String(repeating: "}", count: depth)).utf8)
    }
}
