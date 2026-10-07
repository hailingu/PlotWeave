import Foundation
import Testing
@testable import PlotWeaveNative

/// Outline contract tests verify current logical targets rather than SwiftUI layout or source text.
struct NativeOutlineTests {
    /// Row and group-end actions preserve the declared target and the captured project identity.
    @Test func validDropsPreserveCurrentTargetAndNullableGroup() throws {
        let payload = "{\"projectId\":\"p\",\"id\":\"row:😀\"}"
        let target = HostJSON.object(["kind": .string("row"), "anchorId": .string("anchor"), "position": .string("before")])
        let args = try #require(NativeOutlineContract.moveArguments(payload: payload, projectId: "p", ids: ["row:😀", "anchor"], target: target))
        #expect(args["id"] == .string("row:😀"))
        #expect(args["projectId"] == .string("p"))
        #expect(args["target"] == target)
        let unassigned = HostJSON.object(["kind": .string("groupEnd"), "episode": .null])
        #expect(NativeOutlineContract.moveArguments(payload: payload, projectId: "p", ids: ["row:😀"], target: unassigned)?["target"] == unassigned)
    }

    /// Old projects, deleted sources/anchors and foreign payloads cannot create a move intent.
    @Test func staleAndMalformedDropsAreRejected() {
        let target = HostJSON.object(["kind": .string("row"), "anchorId": .string("anchor"), "position": .string("after")])
        for payload in ["{\"projectId\":\"old\",\"id\":\"row\"}", "{\"projectId\":\"p\",\"id\":\"deleted\"}", "row", "{\"projectId\":\"p\",\"id\":\"row\",\"path\":\"/tmp/private\"}"] {
            #expect(NativeOutlineContract.moveArguments(payload: payload, projectId: "p", ids: ["row", "anchor"], target: target) == nil)
        }
        #expect(NativeOutlineContract.moveArguments(payload: "{\"projectId\":\"p\",\"id\":\"row\"}", projectId: "p", ids: ["row"], target: target) == nil)
    }
}
