import Testing
@testable import PlotWeaveNative

/// Read-only chrome consumes monotonically ordered projections and preserves project targeting.
@MainActor
struct NativeApplicationStateTests {
    @Test func staleProjectionCannotReplaceCurrentProject() throws {
        let state = NativeApplicationState()
        state.beginSession("page")
        try state.receiveProjection([
            "protocolVersion": 1, "sessionId": "page", "sequence": 2,
            "projection": ["app": ["route": "editor", "project": ["id": "new", "name": "新剧"]]]
        ])
        try state.receiveProjection([
            "protocolVersion": 1, "sessionId": "page", "sequence": 1,
            "projection": ["app": ["route": "editor", "project": ["id": "old", "name": "旧剧"]]]
        ])
        #expect(state.projectId == "new")
        #expect(state.projectName == "新剧")
    }

    @Test func invalidatedPageCannotPublishOrDispatchEdits() throws {
        let state = NativeApplicationState()
        state.beginSession("page-a")
        state.beginSession("page-b")
        try state.receiveProjection([
            "protocolVersion": 1, "sessionId": "page-a", "sequence": 10,
            "projection": ["app": ["route": "editor", "project": ["id": "old", "name": "旧剧"]]]
        ])
        #expect(state.projectId == nil)
        #expect(state.route == "loading")
    }
}
