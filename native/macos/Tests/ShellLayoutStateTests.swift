import Testing
@testable import PlotWeaveNative

/// Layout-visibility behavior for the P1 shell containers.
///
/// The inspector toggle is the only chrome state the shell owns in this
/// slice; the sidebar follows the system navigation-split toggle. Flip
/// semantics are covered here so later slices keep the same contract when
/// panels gain real content (`docs/swiftui-react-flow-migration-plan.md` §5
/// P1).
struct ShellLayoutStateTests {

    @Test func inspectorStartsVisible() {
        #expect(ShellLayoutState().inspectorVisible == true)
    }

    @Test func toggleInspectorFlipsVisibility() {
        let state = ShellLayoutState()
        state.toggleInspector()
        #expect(state.inspectorVisible == false)
        state.toggleInspector()
        #expect(state.inspectorVisible == true)
    }
}
