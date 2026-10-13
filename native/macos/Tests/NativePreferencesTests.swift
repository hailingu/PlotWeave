import CryptoKit
import Darwin
import Foundation
import Testing
import Synchronization
@testable import PlotWeaveNative

/// Real disposable roots verify opaque prefs durability and the existing encrypted-provider wire contract.
struct NativePreferencesTests {
    /// Constructing a service never opens real data, and only absence receives first-launch defaults.
    @Test func constructionIsLazyAndMissingPrefsAreEmpty() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-native-prefs-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let prefs = NativePreferences(root: root, machineMaterial: { Self.material })
        #expect(!FileManager.default.fileExists(atPath: root.path))
        #expect(try await prefs.invoke(command: "load_prefs", args: [:]) == .object([:]))
        #expect(!FileManager.default.fileExists(atPath: root.appendingPathComponent("settings.json").path))
    }

    /// Unknown/custom settings survive save/reopen and the credential file is owner-readable/writable only.
    @Test func completeSettingsRoundtripUsesPrivateAtomicPersistence() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let settings = Self.settings(key: Self.v2)
        #expect(try await fixture.prefs.invoke(command: "save_prefs", args: ["prefs": settings]) == .null)
        let reopened = NativePreferences(root: fixture.root, machineMaterial: { Self.material })
        #expect(try await reopened.invoke(command: "load_prefs", args: [:]) == settings)
        let permission = try FileManager.default.attributesOfItem(atPath: fixture.file.path)[.posixPermissions] as? NSNumber
        #expect(permission?.intValue == 0o600)
        #expect(try FileManager.default.contentsOfDirectory(atPath: fixture.root.path).filter { $0.hasSuffix(".tmp") }.isEmpty)
    }

    /// Damaged source bytes are never converted to defaults and are preserved before any explicit replacement.
    @Test func damagedPrefsRejectReadAndReceiveContentAddressedBackupBeforeSave() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let damaged = Data("{broken settings".utf8)
        try damaged.write(to: fixture.file)
        await #expect(throws: HostFailure.self) { try await fixture.prefs.invoke(command: "load_prefs", args: [:]) }
        #expect(try Data(contentsOf: fixture.file) == damaged)
        _ = try await fixture.prefs.invoke(command: "save_prefs", args: ["prefs": Self.settings(key: Self.v2)])
        let digest = SHA256.hash(data: damaged).map { String(format: "%02x", $0) }.joined()
        let backup = fixture.root.appendingPathComponent("settings-corrupt-" + digest + ".bak")
        #expect(try Data(contentsOf: backup) == damaged)
        #expect((try FileManager.default.attributesOfItem(atPath: backup.path)[.posixPermissions] as? NSNumber)?.intValue == 0o600)
    }

    /// Every non-object root is corruption for reads; explicit recovery preserves the exact original bytes.
    @Test(arguments: ["[]", "null", "true", "7", "\"scalar\""])
    func nonObjectRootsRejectBothReadersAndBackUpBeforeRecovery(json: String) async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let damaged = Data(json.utf8)
        try damaged.write(to: fixture.file)
        do {
            _ = try await fixture.prefs.invoke(command: "load_prefs", args: [:])
            Issue.record("Non-object settings must reject instead of becoming defaults")
        } catch let error as HostFailure { #expect(error.code == "PW_PREFS_CORRUPT") }
        do {
            _ = try await fixture.prefs.providerSecret("openai")
            Issue.record("Secret reads must retain the same corruption boundary")
        } catch let error as HostFailure { #expect(error.code == "PW_PREFS_CORRUPT") }
        #expect(try Data(contentsOf: fixture.file) == damaged)
        let recovered = Self.settings(key: Self.v2)
        _ = try await fixture.prefs.invoke(command: "save_prefs", args: ["prefs": recovered])
        let digest = SHA256.hash(data: damaged).map { String(format: "%02x", $0) }.joined()
        let backup = fixture.root.appendingPathComponent("settings-corrupt-" + digest + ".bak")
        #expect(try Data(contentsOf: backup) == damaged)
        #expect((try FileManager.default.attributesOfItem(atPath: backup.path)[.posixPermissions] as? NSNumber)?.intValue == 0o600)
        #expect(try await fixture.prefs.invoke(command: "load_prefs", args: [:]) == recovered)
    }

    /// Save cannot create corruption or mutate existing damage before validating an incoming root.
    @Test func nonObjectWritesPreserveHealthyAndDamagedOriginals() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        for original in [Data("{}".utf8), Data("null".utf8)] {
            try original.write(to: fixture.file)
            for value: HostJSON in [.array([]), .null, .bool(true), .number(7), .string("scalar")] {
                do {
                    _ = try await fixture.prefs.invoke(command: "save_prefs", args: ["prefs": value])
                    Issue.record("Non-object settings writes must be rejected")
                } catch let error as HostFailure { #expect(error.code == "PW_PREFS_INVALID") }
                #expect(try Data(contentsOf: fixture.file) == original)
                #expect(try FileManager.default.contentsOfDirectory(atPath: fixture.root.path) == ["settings.json"])
            }
        }
    }

    /// Cap and no-follow failures cannot be mistaken for a first launch or overwrite an external file.
    @Test func oversizedAndSymlinkPrefsRemainUnreadableAndUnmodified() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let large = Data(repeating: 0x20, count: 1_048_577)
        try large.write(to: fixture.file)
        await #expect(throws: HostFailure.self) { try await fixture.prefs.invoke(command: "load_prefs", args: [:]) }
        #expect(try Data(contentsOf: fixture.file) == large)
        try FileManager.default.removeItem(at: fixture.file)
        let target = fixture.root.appendingPathComponent("external.json")
        let original = try JSONEncoder().encode(Self.settings(key: Self.v2))
        try original.write(to: target)
        try FileManager.default.createSymbolicLink(at: fixture.file, withDestinationURL: target)
        await #expect(throws: HostFailure.self) { try await fixture.prefs.invoke(command: "load_prefs", args: [:]) }
        await #expect(throws: HostFailure.self) { try await fixture.prefs.invoke(command: "save_prefs", args: ["prefs": .object([:])]) }
        #expect(try Data(contentsOf: target) == original)
    }

    /// Encryption returns only a fresh envelope; callers still own when the complete prefs snapshot is saved.
    @Test func encryptionIsBoundToProviderAndCannotWritePrefsByItself() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let encrypted = try await fixture.prefs.invoke(command: "set_provider_key", args: ["providerId": .string("openai"), "key": .string("  fixture-secret-测试  ")])
        let envelope = try #require(encrypted.string)
        #expect(envelope.hasPrefix("pw2:600000:openai:"))
        #expect(!envelope.contains("fixture-secret"))
        #expect(!FileManager.default.fileExists(atPath: fixture.file.path))
        _ = try await fixture.prefs.invoke(command: "save_prefs", args: ["prefs": Self.settings(key: envelope)])
        #expect(try await fixture.prefs.providerSecret("openai") == "fixture-secret-测试")
        #expect(throws: HostFailure.self) { try NativeSeal.open(provider: "other", envelope: envelope, material: Self.material) }
    }

    /// Golden envelopes come from Node's independent AES-GCM/PBKDF2 implementation of the Rust seal contract.
    @Test func goldenV1AndV2DecryptAndLegacyReadMigratesWithoutDroppingOtherFields() async throws {
        #expect(try NativeSeal.open(provider: "openai", envelope: Self.v2, material: Self.material) == "fixture-secret-测试")
        #expect(try NativeSeal.open(provider: "different", envelope: Self.v1, material: Self.material) == "fixture-secret-测试")
        let fixture = try Fixture()
        defer { fixture.remove() }
        _ = try await fixture.prefs.invoke(command: "save_prefs", args: ["prefs": Self.settings(key: Self.v1)])
        #expect(try await fixture.prefs.providerSecret("openai") == "fixture-secret-测试")
        let migrated = try await fixture.prefs.invoke(command: "load_prefs", args: [:])
        #expect(migrated["providers"]?.array.first?["keyEnc"]?.string?.hasPrefix("pw2:600000:openai:") == true)
        #expect(migrated["unrecognized"] == .array([.number(7), .bool(true)]))
        #expect(migrated["defaultChat"] == .string("openai:model"))
    }

    /// Missing machine identity and missing configured keys reject instead of trying Tauri's keychain.
    @Test func unavailableIdentityOrKeyHasNoFallback() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        await #expect(throws: HostFailure.self) { try await fixture.prefs.providerSecret("openai") }
        let unavailable = NativePreferences(root: fixture.root, machineMaterial: { throw HostFailure(code: "PW_MACHINE_UNAVAILABLE", message: "fixture failure") })
        await #expect(throws: HostFailure.self) {
            try await unavailable.invoke(command: "set_provider_key", args: ["providerId": .string("openai"), "key": .string("fixture-secret")])
        }
        #expect(!FileManager.default.fileExists(atPath: fixture.file.path))
    }

    /// Existing frozen ioreg extraction includes the delimiter prefix; changing it invalidates old ciphertext.
    @Test func machineMaterialExtractionRetainsFrozenRustSemantics() throws {
        #expect(try NativeSeal.extractMachineMaterial("    \"IOPlatformUUID\" = \"TEST-MACHINE-UUID\"\n", successful: true) == Self.material)
        #expect(throws: HostFailure.self) { try NativeSeal.extractMachineMaterial("IOPlatformUUID\" = \"truncated", successful: false) }
    }

    /// Failed machine discovery retries, while successful material is cached for later envelope operations.
    @Test func machineDiscoveryRetriesFailureAndCachesOnlySuccess() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-native-prefs-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let probes = Mutex(0)
        let prefs = NativePreferences(root: root, machineMaterial: {
            let attempt = probes.withLock { $0 += 1; return $0 }
            if attempt == 1 { throw HostFailure(code: "PW_MACHINE_UNAVAILABLE", message: "fixture first failure") }
            return Self.material
        })
        let args: [String: HostJSON] = ["providerId": .string("openai"), "key": .string("fixture-key")]
        await #expect(throws: HostFailure.self) { try await prefs.invoke(command: "set_provider_key", args: args) }
        #expect(try await prefs.invoke(command: "set_provider_key", args: args).string?.hasPrefix("pw2:") == true)
        #expect(try await prefs.invoke(command: "set_provider_key", args: args).string?.hasPrefix("pw2:") == true)
        #expect(probes.withLock { $0 } == 2)
        #expect(!FileManager.default.fileExists(atPath: root.path))
    }

    /// Reusing damaged evidence tightens its permissions; mismatched evidence blocks replacement without data loss.
    @Test func repeatedDamageBackupIsPrivateAndCollisionPreservesOriginal() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let damaged = Data("{broken".utf8)
        let digest = SHA256.hash(data: damaged).map { String(format: "%02x", $0) }.joined()
        let backup = fixture.root.appendingPathComponent("settings-corrupt-" + digest + ".bak")
        try damaged.write(to: fixture.file)
        try damaged.write(to: backup)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: backup.path)
        _ = try await fixture.prefs.invoke(command: "save_prefs", args: ["prefs": Self.settings(key: Self.v2)])
        #expect((try FileManager.default.attributesOfItem(atPath: backup.path)[.posixPermissions] as? NSNumber)?.intValue == 0o600)
        try damaged.write(to: fixture.file)
        try Data("different evidence".utf8).write(to: backup)
        await #expect(throws: HostFailure.self) { try await fixture.prefs.invoke(command: "save_prefs", args: ["prefs": .object([:])]) }
        #expect(try Data(contentsOf: fixture.file) == damaged)
    }

    /// Bad rounds, ciphertext tampering and a different machine are all hard failures without plaintext fragments.
    @Test func malformedOrNonMachineEnvelopeCannotDecrypt() throws {
        for envelope in [Self.v2.replacingOccurrences(of: "600000", with: "0"), Self.v2.replacingOccurrences(of: "600000", with: "5000001"), Self.v2 + "zz"] {
            #expect(throws: HostFailure.self) { try NativeSeal.open(provider: "openai", envelope: envelope, material: Self.material) }
        }
        #expect(throws: HostFailure.self) { try NativeSeal.open(provider: "openai", envelope: Self.v2, material: "different fixture machine") }
    }

    /// Opaque field preservation is checked independently of the frontend's normalization helpers.
    private static func settings(key: String) -> HostJSON {
        .object(["providers": .array([.object(["id": .string("openai"), "label": .string("OpenAI"), "keyEnc": .string(key), "models": .array([.string("model")])])]),
                 "defaultChat": .string("openai:model"), "defaultImage": .null,
                 "unrecognized": .array([.number(7), .bool(true)])])
    }
    /// Synthetic machine material and deterministic nonce/salt avoid reading any real machine or secret.
    private static let material = " = \"TEST-MACHINE-UUID"
    /// Frozen pw1 wire vector: SHA256(pepper + material + saltHex), empty AAD, nonce+ciphertext+tag.
    private static let v1 = "pw1:000102030405060708090a0b0c0d0e0f:000102030405060708090a0b6e750af1a5a9e22226dd673d30c9bf203a977b2d5380e5c9009f600beb68e50cfa7111f6cf"
    /// Frozen pw2 wire vector: PBKDF2-HMAC-SHA256 600000, provider AAD, nonce+ciphertext+tag.
    private static let v2 = "pw2:600000:openai:000102030405060708090a0b0c0d0e0f:000102030405060708090a0befb8af7bc6d06a3d8809494dc6119c72de028c2c9caa8b87b0f808d6bc32848b6b679bfa13"

    /// Every fixture owns a fresh temp tree, with construction independent from all production roots.
    private struct Fixture {
        /// Root and leaf are created only for this test's injected persistence actor.
        let root: URL
        let file: URL
        let prefs: NativePreferences
        /// Test-side directory creation is deliberately separate from production creation behavior.
        init() throws {
            root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-native-prefs-" + UUID().uuidString)
            file = root.appendingPathComponent("settings.json")
            prefs = NativePreferences(root: root, machineMaterial: { NativePreferencesTests.material })
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        }
        /// Removes only the fixture after all awaited work has settled.
        func remove() { try? FileManager.default.removeItem(at: root) }
    }
}
