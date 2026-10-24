import Foundation
import Testing
@testable import PlotWeaveNative

/// Web staging preserves the existing native persistence and rejection boundaries.
@MainActor
struct NativeLibraryUploadTests {
    /// Complete chunks commit once through the normal library journal and diagnostics.
    @Test func chunksPersistExactBytesAndKeepDiagnostics() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-upload-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let library = NativeLibrary(root: root)
        let bytes = Data(repeating: 91, count: NativeLibraryUploads.chunkBytes + 7)
        let first = try await library.invoke(command: "import_library_asset_chunk", args: ["request": .object(request("a", bytes.count, 0, bytes.prefix(NativeLibraryUploads.chunkBytes)))])
        #expect(first["received"]?.number == Double(NativeLibraryUploads.chunkBytes))
        #expect(!FileManager.default.fileExists(atPath: root.path))
        let asset = try await library.invoke(command: "import_library_asset_chunk", args: ["request": .object(request("a", bytes.count, NativeLibraryUploads.chunkBytes, bytes.suffix(7)))])
        let relative = try #require(asset["relPath"]?.string)
        #expect(try Data(contentsOf: root.appendingPathComponent("library/" + relative)) == bytes)
        #expect(asset["cleanupPending"]?.arrayValue != nil)
        #expect(asset["diagnosticsRevision"]?.string != nil)
    }

    /// Hard resource limits, expiry and invalid continuation release only their upload.
    @Test func stagingLimitsAndExpiryAreRecoverable() throws {
        let now = Date()
        var uploads = NativeLibraryUploads()
        for id in ["a", "b"] { _ = try uploads.accept(request(id, 2, 0, Data([1])), now: now) }
        #expect(throws: (any Error).self) { try uploads.accept(request("c", 2, 0, Data([1])), now: now) }
        _ = try uploads.accept(request("a", 0, 0, Data()), now: now)
        _ = try uploads.accept(request("c", 2, 0, Data([1])), now: now)
        #expect(throws: (any Error).self) { try uploads.accept(request("b", 2, 1, Data([2])), now: now.addingTimeInterval(120)) }
        _ = try uploads.accept(request("a", 2, 0, Data([1])), now: now.addingTimeInterval(120))
        #expect(throws: (any Error).self) { try uploads.accept(request("a", 2, 2, Data([2])), now: now.addingTimeInterval(120)) }
        for (total, data) in [(NativeLibrary.maximumBytes + 1, Data([1])), (0, Data([1])), (2, Data()), (1, Data([1, 2])), (NativeLibraryUploads.chunkBytes + 1, Data(repeating: 1, count: NativeLibraryUploads.chunkBytes + 1))] {
            #expect(throws: (any Error).self) { try uploads.accept(request("a", total, 0, data), now: now) }
        }
        for total in [NativeLibrary.maximumBytes - 1, NativeLibrary.maximumBytes] {
            _ = try uploads.accept(request("a", total, 0, Data([1])), now: now)
            _ = try uploads.accept(request("a", 0, 0, Data()), now: now)
        }
    }

    /// Final validation failure must retire its charged slot and leave the next upload usable.
    @Test func commitFailureReleasesSlotWithoutCreatingFiles() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-upload-failure-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let library = NativeLibrary(root: root)
        _ = try await library.invoke(command: "import_library_asset_chunk", args: ["request": .object(request("b", 2, 0, Data([1])))])
        var bad = request("a", 1, 0, Data([1])); bad["kind"] = .string("bad")
        await #expect(throws: (any Error).self) { try await library.invoke(command: "import_library_asset_chunk", args: ["request": .object(bad)]) }
        _ = try await library.invoke(command: "import_library_asset_chunk", args: ["request": .object(request("c", 2, 0, Data([1])))])
        #expect(!FileManager.default.fileExists(atPath: root.path))
    }

    /// Tests construct the public wire envelope, independent of the registry implementation.
    private func request(_ id: String, _ total: Int, _ offset: Int, _ bytes: Data) -> [String: HostJSON] {
        ["uploadId": .string(id), "name": .string("参考.bmp"), "mime": .string("image/bmp"), "kind": .string("reference"),
         "total": .number(Double(total)), "offset": .number(Double(offset)), "data": .string(bytes.base64EncodedString())]
    }
}
