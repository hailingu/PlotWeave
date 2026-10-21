import Foundation
import Testing
@testable import PlotWeaveNative

/// The loading shield follows one validated project's generation; late receipts cannot release a newer project.
@MainActor
struct NativeEditorPreparationTests {
    /// App navigation may precede the matching editor snapshot and real field layout.
    @Test func matchingSnapshotAndLayoutAreBothRequired() {
        let preparation = NativeEditorPreparation()
        preparation.receive(projectID: "a", editor: .null)
        let token = preparation.generation
        #expect(preparation.pending)
        preparation.complete(token)
        #expect(preparation.pending)
        preparation.receive(projectID: "a", editor: snapshot("a"))
        #expect(preparation.pending)
        #expect(preparation.seeds.first?["id"]?.string == "first")
        preparation.complete(token)
        #expect(!preparation.pending)
        preparation.receive(projectID: "a", editor: snapshot("a"))
        #expect(!preparation.pending, "普通投影不得反复进入加载或重新准备")
    }

    /// Loading prepares one necessary kind per real layout receipt and ignores premature receipts.
    @Test func everyProjectKindMustPrepareBeforeTheShieldLeaves() {
        let preparation = NativeEditorPreparation()
        let scene = HostJSON.object(["id": .string("scene"), "type": .string("scene"), "data": .object([:])])
        let shot = HostJSON.object(["id": .string("shot"), "type": .string("shot"), "data": .object([:])])
        preparation.receive(projectID: "a", editor: .object(["projectId": .string("a"), "inspectorSeeds": .array([scene, shot])]))
        let token = preparation.generation
        #expect(preparation.activatedKinds.isEmpty)
        preparation.start(token)
        #expect(preparation.activatedKinds == ["scene"])
        preparation.fieldReady(token, kind: "shot")
        #expect(preparation.pending)
        preparation.fieldReady(token, kind: "scene")
        #expect(preparation.activatedKinds == ["scene", "shot"])
        #expect(preparation.pending)
        preparation.fieldReady(token, kind: "shot")
        #expect(!preparation.pending)
    }

    /// A→B→A and page reset invalidate every previous asynchronous layout receipt.
    @Test func projectAndSessionChangesRejectOldReceipts() {
        let preparation = NativeEditorPreparation()
        preparation.receive(projectID: "a", editor: snapshot("a"))
        let old = preparation.generation
        preparation.receive(projectID: "b", editor: snapshot("b"))
        preparation.complete(old)
        #expect(preparation.pending)
        preparation.receive(projectID: "a", editor: snapshot("a"))
        preparation.complete(old)
        #expect(preparation.pending)
        let beforeReset = preparation.generation
        preparation.reset()
        preparation.receive(projectID: "a", editor: snapshot("a"))
        preparation.complete(beforeReset)
        #expect(preparation.pending)
        preparation.complete(preparation.generation)
        #expect(!preparation.pending)
    }

    /// Timeout keeps the shield visible; retry owns a fresh generation and cannot accept an old success.
    @Test func timeoutRequiresExplicitRetry() {
        let preparation = NativeEditorPreparation()
        preparation.receive(projectID: "a", editor: snapshot("a"))
        let old = preparation.generation
        preparation.fail(old)
        #expect(preparation.error != nil)
        preparation.complete(old)
        #expect(preparation.pending)
        preparation.retry()
        #expect(preparation.error == nil)
        #expect(preparation.generation != old)
        preparation.complete(old)
        #expect(preparation.pending)
        preparation.complete(preparation.generation)
        #expect(!preparation.pending)
    }

    /// Empty graphs and older projections have no field work to wait for; a mismatched project stays blocked.
    @Test func emptyAndLegacySnapshotsDoNotWaitForMissingFields() {
        let preparation = NativeEditorPreparation()
        preparation.receive(projectID: "a", editor: snapshot("other"))
        #expect(preparation.pending)
        preparation.receive(projectID: "a", editor: .object(["projectId": .string("a"), "inspectorSeeds": .array([])]))
        #expect(!preparation.pending)
        preparation.receive(projectID: "b", editor: .object(["projectId": .string("b")]))
        #expect(!preparation.pending)
        preparation.receive(projectID: nil, editor: .null)
        #expect(!preparation.pending)
        #expect(preparation.seeds.isEmpty)
    }

    /// A bounded read-only seed stands in for the first real node without mutating selection.
    private func snapshot(_ project: String) -> HostJSON {
        .object(["projectId": .string(project), "inspectorSeeds": .array([.object([
            "id": .string("first"), "type": .string("scene"), "data": .object(["name": .string("首拖")])
        ])])])
    }
}
