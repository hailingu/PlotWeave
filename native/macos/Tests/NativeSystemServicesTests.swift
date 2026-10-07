import AppKit
import Foundation
import Testing
@testable import PlotWeaveNative

/// Actual pasteboard and temporary exported files prove system side effects and cancellation reply semantics.
@MainActor
struct NativeSystemServicesTests {
    /// Exact Unicode text reaches an isolated native pasteboard and the wire value is JSON null.
    @Test func copyTextUsesNativePasteboardAndNullReply() async throws {
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        let services = NativeHostServices(dataRoot: nil, quit: HostQuitController(), pasteboard: board)
        let result = try await services.perform(request("system.copyText", ["text": .string("第一幕\n林舟：你好。")]))
        #expect(result == .null)
        #expect(board.string(forType: .string) == "第一幕\n林舟：你好。")
    }

    /// User cancellation is visible and creates no file, while success commits the exact chosen export bytes.
    @Test func saveTextCancellationAndSuccessfulWriteAreDifferentResults() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-native-export-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let args: [String: HostJSON] = ["text": .string("{\"剧本\":true}"), "fileName": .string("剧本.json")]
        let cancelled = NativeHostServices(dataRoot: nil, quit: HostQuitController(), saveDestination: { _ in nil })
        #expect(try await cancelled.perform(request("system.saveText", args)) == .object(["cancelled": .bool(true)]))
        #expect(try FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty)
        let target = root.appendingPathComponent("剧本.json")
        let chosen = NativeHostServices(dataRoot: nil, quit: HostQuitController(), saveDestination: { _ in target })
        #expect(try await chosen.perform(request("system.saveText", args)) == .object(["cancelled": .bool(false)]))
        #expect(try String(contentsOf: target, encoding: .utf8) == "{\"剧本\":true}")
    }

    /// A failed filesystem export remains an error rather than being confused with user cancellation.
    @Test func saveTextFailureIsObservable() async throws {
        let target = FileManager.default.temporaryDirectory.appendingPathComponent("pw-missing-parent-" + UUID().uuidString).appendingPathComponent("file.json")
        let services = NativeHostServices(dataRoot: nil, quit: HostQuitController(), saveDestination: { _ in target })
        do {
            _ = try await services.perform(request("system.saveText", ["text": .string("x"), "fileName": .string("file.json")]))
            Issue.record("Missing destination parent cannot be reported as a successful export")
        } catch let failure as HostFailure { #expect(failure.code == "PW_SAVE_FAILED") }
    }

    /// Version/session fields match the same declared request shape consumed by the real router.
    private func request(_ command: String, _ args: [String: HostJSON]) -> HostRequest {
        HostRequest(protocolVersion: 1, sessionId: "fixture", requestId: UUID().uuidString, command: command, args: args)
    }
}
