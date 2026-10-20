import Foundation
import Synchronization
import Testing
@testable import PlotWeaveNative

/// Invalid or ambiguous configuration must refuse before even probing machine key material.
struct NativeProviderBindingTests {
    /// Malformed ciphers cannot hide an accidental decrypt before the destination has been authorized.
    @Test func invalidConfigurationNeverOpensCredentials() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-provider-binding-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let probes = Mutex(0)
        let prefs = NativePreferences(root: root, machineMaterial: { probes.withLock { $0 += 1 }; return "fixture" })
        let valid: HostJSON = .object(["id": .string("custom"), "baseUrl": .string("https://provider.example/v1"), "keyEnc": .string("invalid")])
        for providers: HostJSON in [.array([]), .array([valid, valid]), .array([.object(["id": .string("custom"), "keyEnc": .string("invalid")])])] {
            _ = try await prefs.invoke(command: "save_prefs", args: ["prefs": .object(["providers": providers])])
            await #expect(throws: HostFailure.self) { try await prefs.providerCredential("custom", baseURL: "https://provider.example/v1", suffix: "chat/completions") }
        }
        _ = try await prefs.invoke(command: "save_prefs", args: ["prefs": .object(["providers": .array([valid])])])
        await #expect(throws: HostFailure.self) { try await prefs.providerCredential("custom", baseURL: "https://other.example/v1", suffix: "images/generations") }
        #expect(probes.withLock { $0 } == 0)
    }
}
