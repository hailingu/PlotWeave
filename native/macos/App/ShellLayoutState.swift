import Observation

/// Layout state owned by the native shell root: visibility of the panels the
/// shell itself toggles.
///
/// In this P1 slice only the inspector is shell-owned; the sidebar follows
/// the system navigation-split toolbar toggle. The canvas placeholder reads
/// no layout state.
@Observable
final class ShellLayoutState {

    /// Whether the trailing inspector column is shown.
    var inspectorVisible = true

    /// Flips inspector visibility; bound to the trailing toolbar toggle.
    func toggleInspector() {
        inspectorVisible.toggle()
    }
}
