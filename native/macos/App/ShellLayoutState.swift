import Observation

/// Layout state owned by the native shell root: visibility of the panels the
/// shell itself toggles.
///
/// The inspector is toggled by the shell toolbar; `sidebarVisible` drives
/// the split view's column visibility so the system navigation toggle and
/// tests share one source. The canvas placeholder reads no layout state —
/// panel changes must not rebuild the hosted web view (plan §4.2).
@Observable
final class ShellLayoutState {

    /// Whether the trailing inspector column is shown.
    var inspectorVisible = true

    /// Whether the navigation sidebar column is shown.
    var sidebarVisible = true

    /// Flips inspector visibility; bound to the trailing toolbar toggle.
    func toggleInspector() {
        inspectorVisible.toggle()
    }
}
