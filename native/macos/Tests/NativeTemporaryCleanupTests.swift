import Foundation
import Testing
@testable import PlotWeaveNative

/// Startup maintenance never treats foreign, active, future-dated or linked files as recoverable project writes.
struct NativeTemporaryCleanupTests {
    /// Actual project listing removes only aged, ordinary temps with a valid project target and emitted ID.
    @Test func projectListingSweepsOnlyOwnedAgedRegularTemporaryFiles() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-native-temps-" + UUID().uuidString)
        let directory = root.appendingPathComponent("projects")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let aged = Date().addingTimeInterval(-90_000)
        let removed = ".p-one.json.p-18f-0.tmp"
        let retained = [".p-two.json.p-18f-1.tmp", "notes.tmp", ".notes.backup.tmp", ".notes.p-18f-0.tmp", ".p-one.json.p-19F-0.tmp", ".p-one.json.p-18f.tmp", ".p-one.json.p-18f-2.tmp"]
        for name in [removed] + retained {
            let path = directory.appendingPathComponent(name)
            try Data([1]).write(to: path)
            try FileManager.default.setAttributes([.modificationDate: aged], ofItemAtPath: path.path)
        }
        try FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: directory.appendingPathComponent(retained[0]).path)
        try FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(100_000)], ofItemAtPath: directory.appendingPathComponent(retained.last!).path)
        let outside = root.appendingPathComponent("original")
        try Data([99]).write(to: outside)
        let linked = directory.appendingPathComponent(".p-one.json.p-18f-3.tmp")
        try FileManager.default.createSymbolicLink(at: linked, withDestinationURL: outside)
        let store = NativeProjectStore(root: root)
        #expect(try await store.invoke(command: "list_projects", args: [:]) == .array([]))
        #expect(!FileManager.default.fileExists(atPath: directory.appendingPathComponent(removed).path))
        for name in retained { #expect(FileManager.default.fileExists(atPath: directory.appendingPathComponent(name).path)) }
        #expect(try Data(contentsOf: outside) == Data([99]))
        #expect(try FileManager.default.destinationOfSymbolicLink(atPath: linked.path) == outside.path)
        await store.close()
    }
}
