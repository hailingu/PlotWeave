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

    /// Canvas failure is a visible, retryable state: it suppresses welcome geometry and clears only on a valid projection.
    @Test func canvasFailureSuppressesWelcomeUntilAValidProjection() throws {
        let state = NativeApplicationState()
        state.beginSession("page")
        state.invalidate("画布失败")
        #expect(state.canvasUnavailable)
        #expect(state.error == "画布失败")
        #expect(state.route == "loading")
        state.beginSession("retry-page")
        #expect(state.canvasUnavailable, "重试页面接入时失败呈现必须保留到有效投影")
        try state.receiveProjection([
            "protocolVersion": 1, "sessionId": "retry-page", "sequence": 1,
            "projection": ["app": ["route": "editor", "project": ["id": "new", "name": "新剧"]]]
        ])
        #expect(!state.canvasUnavailable)
        #expect(state.error == nil)
        #expect(state.projectId == "new")
    }

    /// Near-simultaneous failures stay individually visible; the later completion must not overwrite the earlier (issue #724).
    @Test func backToBackFailuresStayIndividuallyVisible() async throws {
        let state = NativeApplicationState()
        state.beginSession("page")
        // Without a connected canvas the app command fails on its asynchronous completion, while the editor
        // form fails synchronously because no project is open: two failures that complete back to back.
        state.send("app.home")
        state.sendEditor("editor.rename")
        try await settle(state)
        #expect(state.error?.contains("没有打开的项目") == true, "先完成的失败原因必须保留")
        #expect(state.error?.contains("画布尚未就绪") == true, "后完成的失败原因同样可见")
    }

    /// Every asynchronous failure is retained, and the next explicit action acknowledges the whole queue (issue #724).
    @Test func explicitActionAcknowledgesQueuedFailures() async throws {
        let state = NativeApplicationState()
        state.beginSession("page")
        state.send("app.home")
        state.send("app.retry")
        try await settle(state)
        #expect(state.errors.count == 2, "两个异步失败均入队")
        state.send("app.home")
        #expect(state.errors.isEmpty, "新的显式操作确认此前呈现的全部失败")
        try await settle(state)
        #expect(state.errors.count == 1)
        #expect(state.error == state.errors.first, "单失败横幅文本与队列唯一条目一致")
    }

    /// A page failure supersedes command failures of the dead session so the retry overlay presents one cause.
    @Test func canvasFailureReplacesQueuedCommandFailures() async throws {
        let state = NativeApplicationState()
        state.beginSession("page")
        state.send("app.home")
        try await settle(state)
        try #require(state.errors.count == 1)
        state.invalidate("画布失败")
        #expect(state.errors == ["画布失败"])
        #expect(state.error == "画布失败")
    }

    /// Blocking app commands settle on the main actor; polling keeps these tests free of canvas fixtures.
    private func settle(_ state: NativeApplicationState) async throws {
        let deadline = ContinuousClock.now + .seconds(5)
        while state.busy, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
        try #require(!state.busy, "应用命令应在超时前完成")
    }
}
