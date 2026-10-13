import Testing
@testable import PlotWeaveNative

/// Load-lifecycle behavior for the WKWebView canvas host (P1 visual slice).
///
/// The state machine backs the M01 readiness contract in
/// `docs/swiftui-react-flow-migration-plan.md` §6: the shell must show a
/// visible diagnostic on load failure, never a fake empty project, and a
/// late ready message from an already-failed load must not mask the failure.
@MainActor
struct WebCanvasStateTests {

    @Test func startsLoadingWithZeroReloadToken() {
        let state = WebCanvasState()
        #expect(state.phase == .loading)
        #expect(state.reloadToken == 0)
    }

    @Test func markReadyTransitionsLoadingToReady() {
        let state = WebCanvasState()
        state.markReady()
        #expect(state.phase == .ready)
    }

    @Test func failureRecordsDiagnosticMessage() {
        let state = WebCanvasState()
        state.fail("画布资源缺失")
        #expect(state.phase == .failed("画布资源缺失"))
    }

    @Test func lateReadyDoesNotMaskFailure() {
        let state = WebCanvasState()
        state.fail("加载失败")
        state.markReady()
        #expect(state.phase == .failed("加载失败"))
    }

    @Test func retryResetsToLoadingAndBumpsReloadToken() {
        let state = WebCanvasState()
        state.fail("加载失败")
        state.retry()
        #expect(state.phase == .loading)
        #expect(state.reloadToken == 1)
    }
}
