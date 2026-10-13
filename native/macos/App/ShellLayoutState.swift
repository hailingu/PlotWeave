import Observation

/// Layout state owned by the native shell root: visibility of the panels the
/// shell itself toggles.
///
/// The inspector is toggled by the shell toolbar; `sidebarVisible` drives
/// the split view's column visibility so the native outline toggle and
/// tests share one source. The retained canvas reads no panel preference —
/// panel changes must not rebuild the hosted web view (plan §4.2).
@Observable
final class ShellLayoutState {

    /// User preference for showing the trailing inspector while editing; non-editor routes temporarily hide it.
    var inspectorVisible = true

    /// User preference for the editor sidebar; non-editor routes hide it without changing this value.
    var sidebarVisible = true

    /// Flips inspector visibility; bound to the trailing toolbar toggle.
    func toggleInspector() {
        inspectorVisible.toggle()
    }
}
