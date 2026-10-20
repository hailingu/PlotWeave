import AppKit
import ApplicationServices
import SwiftUI
import Testing
@testable import PlotWeaveNative

/// Native sheet, forms and thumbnail execute real UI actions against one disposable persistent library.
@MainActor
@Suite(.serialized)
struct NativeLibraryPresentationExecutionTests {
    /// Saved form values are verified after reopening the real actor, including explicit null optional fields.
    @Test func assetFormPersistsSubmittedPatchAndGroupFormRetainsIdentity() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-library-controls-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let library = NativeLibrary(root: root)
        let asset = try await library.importAsset(name: "原始素材", mime: "image/png", kind: "character", bytes: Data([1]))
        let id = try #require(asset["id"]?.string)
        var submitted: HostJSON?
        let view = NativeCoverageWindow(NativeLibraryAssetForm(asset: asset, groups: [], busy: false) { submitted = $0 })
        defer { view.close() }
        try await view.enter("  新素材  ", replacing: "原始素材")
        try await view.press("保存")
        try await NativeCoverageWindow.wait { submitted != nil }
        let patch = try #require(submitted)
        #expect(patch["view"] == .null && patch["groupId"] == .null)
        #expect(patch["tags"] == .array([]))
        _ = try await library.invoke(command: "update_library_asset", args: ["id": .string(id), "patch": patch])
        let reopened = NativeLibrary(root: root)
        let persisted = try await reopened.invoke(command: "list_library_assets", args: [:])
        #expect(persisted["assets"]?["byId"]?[id]?["name"]?.string == "新素材")
        let group = HostJSON.object(["id": .string("stable-group"), "name": .string("原始编组"), "kind": .string("character")])
        submitted = nil
        view.mount(NativeLibraryGroupForm(group: group, busy: false, error: "可重试的合成错误") { submitted = $0 })
        try await view.enter("  新编组  ", replacing: "原始编组")
        try await view.press("保存")
        try await NativeCoverageWindow.wait { submitted != nil }
        #expect(submitted?["id"]?.string == "stable-group")
        _ = try await library.invoke(command: "upsert_library_group", args: ["group": try #require(submitted)])
        let grouped = try await reopened.invoke(command: "list_library_assets", args: [:])
        #expect(grouped["groups"]?["byId"]?["stable-group"]?["name"]?.string == "新编组")
    }

    /// Invalid drafts and in-flight writes disable the actual submit control; callback counts cannot hide an enabled button.
    @Test func blankAndBusyFormsDisableSubmission() async throws {
        let view = NativeCoverageWindow(Text("fixture"))
        defer { view.close() }
        for busy in [false, true] {
            view.mount(NativeLibraryGroupForm(group: .object(["id": .string("g"), "name": .string(busy ? "valid" : "  "), "kind": .string("character")]), busy: busy) { _ in Issue.record("Disabled form submitted") })
            let button = try await NativeCreationControlFixture.button(in: view.window, named: "保存")
            #expect(!(try NativeCreationControlFixture.isEnabled(button)))
        }
    }

    /// The actual sheet loads the service-owned actor; filtering a populated list must show its real empty-search state.
    @Test func librarySheetLoadsOwnedRowsAndFiltersWithoutChangingDisk() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-library-sheet-" + UUID().uuidString)
        let services = NativeHostServices(dataRoot: root, quit: HostQuitController())
        defer { try? FileManager.default.removeItem(at: root) }
        let library = try await services.libraryService()
        _ = try await library.importAsset(name: "可搜索素材", mime: "text/plain", kind: "other", bytes: Data("fixture".utf8))
        let view = NativeCoverageWindow(NativeLibrarySheet(state: NativeApplicationState(), services: services))
        defer { view.close() }
        var strings: [String] = []
        for _ in 0..<60 {
            strings = try await view.strings()
            if strings.contains("可搜索素材") { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(strings.contains("可搜索素材"))
        try await view.enter("没有匹配项", replacing: "")
        let filtered = try await view.strings()
        #expect(!filtered.contains("可搜索素材"))
        let persisted = try await library.invoke(command: "list_library_assets", args: [:])
        #expect(persisted["assets"]?["byId"]?.object?.count == 1)
        view.close()
        await services.close()
    }

    /// Invalid stored image bytes expose a real retry action, then valid replacement bytes decode after that action.
    @Test func thumbnailRetryRecoversFromPersistedDecodeFailure() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pw-library-thumbnail-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let library = NativeLibrary(root: root)
        let asset = try await library.importAsset(name: "fixture.png", mime: "image/png", kind: "other", bytes: Data([1]))
        let view = NativeCoverageWindow(NativeLibraryThumbnail(asset: asset, library: library))
        defer { view.close() }
        var retry: AXUIElement?
        for _ in 0..<60 {
            retry = try await NativeCreationControlFixture.elements(in: view.window).first { NativeCreationControlFixture.string($0, kAXRoleAttribute) == kAXButtonRole && NativeCreationControlFixture.string($0, kAXSubroleAttribute) == nil }
            if retry != nil { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        let button = try #require(retry)
        let image = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 2, pixelsHigh: 2, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
        for x in 0..<2 { for y in 0..<2 { image?.setColor(.black, atX: x, y: y) } }
        let png = try #require(image?.representation(using: .png, properties: [:]))
        let relative = try #require(asset["relPath"]?.string)
        try png.write(to: root.appendingPathComponent("library").appendingPathComponent(relative))
        _ = AXUIElementPerformAction(button, kAXPressAction as CFString)
        var recovered = false
        for _ in 0..<60 {
            let elements = try await NativeCreationControlFixture.elements(in: view.window)
            if !elements.contains(where: { NativeCreationControlFixture.string($0, kAXRoleAttribute) == kAXButtonRole && NativeCreationControlFixture.string($0, kAXSubroleAttribute) == nil }) { recovered = true; break }
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(recovered)
        #expect(try await library.openMedia(id: try #require(asset["id"]?.string)).read(maxBytes: 1024) == png)
    }
}
