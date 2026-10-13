import Testing
@testable import PlotWeaveNative

/// Honesty checks for the shell's stage record after the P1 visual slice.
///
/// The WKWebView canvas host now renders the in-memory demo fixture, so the
/// record must say the web canvas IS hosted while staying explicit that
/// nothing persists — a demo build must never be mistaken for the editing
/// product (`docs/swiftui-react-flow-migration-plan.md` §5 P1).
struct ShellStageTests {

    @Test func currentStageHostsWebCanvasDemoWithoutPersistence() {
        #expect(ShellStage.current.includesWebCanvas == true)
        #expect(ShellStage.current.persistEdits == false)
    }

    @Test func currentStageExposesReadablePlaceholderText() {
        #expect(!ShellStage.current.title.isEmpty)
        #expect(!ShellStage.current.summary.isEmpty)
    }
}
