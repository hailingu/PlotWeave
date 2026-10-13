import Foundation
import Testing
@testable import PlotWeaveNative

/// Native library filtering preserves source identities and excludes unsupported dirty presentation entries.
struct NativeLibraryFormsTests {
    /// A matching name or tag respects the chosen category and retains the authoritative map key.
    @Test func nativeFiltersRetainRealAssetIdentity() throws {
        let source = HostJSON.object(["assets": .object(["byId": .object([
            "hero": .object(["id": .string("hero"), "name": .string("林晚"), "kind": .string("character"), "tags": .array([.string("夜景")])]),
            "street": .object(["id": .string("street"), "name": .string("夜景街道"), "kind": .string("location"), "tags": .array([])])
        ])])])
        let filtered = NativeLibraryPresentation(source, kind: "character", query: " 夜景 ")
        #expect(filtered.items.count == 1)
        #expect(filtered.items.first?["id"] == .string("hero"))
        #expect(NativeLibraryPresentation(source, query: "不存在").items.isEmpty)
    }
}
